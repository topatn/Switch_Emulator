// web/src/workers/common.ts
//
// Shared worker plumbing: the boot sequence every worker type runs.
//
// Part 5 puts a thin TS wrapper in each worker that hosts a WASM core. The
// duplication between them is small but real, and it is duplication that must
// stay *identical* — a divergence in how two workers attach to the core is a
// bug that only shows up as one worker misbehaving at runtime. So the sequence
// lives here and each worker supplies only its identity and its extra setup.

import {
  instantiateCore,
  initCore,
  readTelemetry,
  makeCoreMemory,
  CoreLoadError,
  type CoreAttachInfo,
  type RegionInfo,
} from '../core/instantiate';
import {
  ControlBlock,
  WorkerKind,
  WORKER_LABEL,
  type BootOk,
  type WorkerFailed,
  type WorkerRequest,
  type WorkerResponse,
} from '../platform/protocol';

export interface WorkerContext {
  kind: WorkerKind;
  /** Attached core, available after bootWorker() resolves. */
  info?: CoreAttachInfo;
  control?: ControlBlock;
}

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

export function reportError(kind: WorkerKind, error: unknown, fatal = true): void {
  const isCoreError = error instanceof CoreLoadError;
  const message = error instanceof Error ? error.message : String(error);
  post({
    type: 'error',
    kind,
    message,
    remedy: isCoreError ? (error as CoreLoadError).remedy : undefined,
    fatal,
  } as WorkerFailed);
  if (fatal) console.error(`[${WORKER_LABEL[kind]}]`, error);
}

export function log(kind: WorkerKind, level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', kind, level, message });
}

/** Regions a given worker actually needs, for the boot report. */
function summariseRegions(regions: RegionInfo[]): RegionInfo[] {
  return regions.map((r) => ({ ...r, bytes: new Uint8Array(0) }));
}

/**
 * Boots a worker: instantiate the core, initialise its arena, read back the
 * region table, and report success.
 *
 * `ctx` is the caller's own WorkerContext, not a fresh one, and that matters.
 * Every worker's module-level `ctx` is the object its later code reads
 * (`ctx.info?.exports...`) and the object its request handler closes over. If this
 * function created its own context and returned it, the caller's `ctx.info` would
 * stay undefined and the first post-boot call would throw
 * `Cannot read properties of undefined (reading 'exports')` — a failure that only
 * appears after a boot that reported success.
 */
export async function bootWorker(ctx: WorkerContext, msg: Extract<WorkerRequest, { type: 'boot' }>): Promise<WorkerContext> {
  const kind = ctx.kind;

  if (msg.control) {
    ctx.control = new ControlBlock(msg.control);
    // Fail fast and loudly on a layout mismatch rather than scribbling over a
    // control block another worker is already using.
    ctx.control.assertLayout();
  }

  const info = await instantiateCore(msg.coreBaseUrl);
  const regions = initCore(info, msg.arenaBytes);
  ctx.info = info;

  ctx.control?.markAttached(kind);

  const ok: BootOk = {
    type: 'booted',
    seq: msg.seq,
    kind,
    abiVersion: info.abiVersion,
    buildId: info.buildId,
    features: info.features,
    arenaBytes: info.exports.sw_core_arena_size(),
    arenaUsedBytes: info.exports.sw_core_arena_used(),
    isSharedMemory: info.isShared,
    regions: summariseRegions(regions),
  };
  post(ok);

  return ctx;
}

/**
 * Installs the common request handler and lets a worker add its own cases.
 *
 * `handlers` is keyed by request type; anything not listed falls through to an
 * explicit "unsupported" error rather than being ignored, because a silently
 * dropped request is how a worker and the shell drift apart.
 */
/** Handler map a worker passes to `installCommonHandlers`. */
export type WorkerHandlers = Partial<
  Record<WorkerRequest['type'], (msg: never) => Promise<void> | void>
>;

export function installCommonHandlers(ctx: WorkerContext, handlers: WorkerHandlers = {}): void {
  const handle = async (msg: WorkerRequest) => {
    switch (msg.type) {
      case 'ping': {
        // Two timings are recorded: the worker's own WASM-call time, and the
        // caller's full round trip. The gate is on the latter.
        const t0 = performance.now();
        ctx.info?.exports.sw_core_ping(msg.seq);
        post({
          type: 'pong',
          kind: ctx.kind,
          seq: msg.seq,
          workerElapsedMs: performance.now() - t0,
        });
        return;
      }

      case 'telemetry': {
        const info = ctx.info;
        if (!info) {
          reportError(ctx.kind, new Error('telemetry requested before boot'), false);
          return;
        }
        info.exports.sw_core_telemetry_refresh();
        const t = readTelemetry(info);
        post({
          type: 'telemetry',
          kind: ctx.kind,
          seq: msg.seq,
          abiVersion: t.abiVersion,
          initState: t.initState,
          arenaBytes: t.arenaBytes,
          arenaUsedBytes: info.exports.sw_core_arena_used(),
          lastRoundtripNs: t.lastRoundtripNs,
          monotonicNs: info.exports.sw_core_monotonic_ns(),
        });
        return;
      }

      case 'grow-arena': {
        const info = ctx.info;
        if (!info) {
          reportError(ctx.kind, new Error('grow-arena requested before boot'), false);
          return;
        }
        const bufferBefore = info.memory.buffer;
        // `sw_arena_grow`, not `sw_core_grow`: growth is an arena operation. The
        // core-level surface deliberately has no growth entry point, so nothing
        // can grow the arena without also handling view invalidation.
        const arenaBytes = info.exports.sw_arena_grow(msg.deltaBytes);

        // Part 3.3 / Part 7 risk 4: growth may move the base pointer, detaching
        // the exported buffer and invalidating every existing view. Compare the
        // buffer identity rather than inferring from sizes, then re-derive.
        const bufferDetached = info.wasmMemory.buffer !== bufferBefore;
        if (bufferDetached) {
          info.memory = makeCoreMemory(info.wasmMemory);
          if (bufferDetached) {
            log(
              ctx.kind,
              'info',
              `Arena grew to ${arenaBytes} bytes; the shared memory buffer was reallocated and all views were re-derived.`,
            );
          }
        }

        post({ type: 'arena-grown', kind: ctx.kind, seq: msg.seq, arenaBytes, bufferDetached });
        return;
      }

      case 'shutdown': {
        ctx.info?.exports.sw_core_shutdown();
        ctx.control?.markDetached(ctx.kind);
        ctx.control?.setRunState(2);
        return;
      }

      case 'boot':
        // Handled by each worker's own listener, which installs additional
        // behaviour after the common sequence (the CPU worker's latency gate, the
        // GPU worker's adapter probe, the I/O worker's folder scan). Falling
        // through to the default branch here would report a spurious error on
        // every boot, which is exactly the sort of noise that trains people to
        // ignore the log.
        return;

      default: {
        const custom = handlers[msg.type];
        if (custom) {
          await (custom as (m: WorkerRequest) => Promise<void> | void)(msg);
          return;
        }
        reportError(
          ctx.kind,
          new Error(`Worker ${WORKER_LABEL[ctx.kind]} does not handle request '${String((msg as WorkerRequest).type)}'.`),
          false,
        );
      }
    }
  };

  self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    void handle(event.data).catch((e) => reportError(ctx.kind, e));
  });
}
