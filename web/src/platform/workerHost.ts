// web/src/platform/workerHost.ts
//
// Main-thread supervisor for the four workers in Part 3.9's topology.
//
// Responsibilities, all of which the main thread owns because they are the only
// place these APIs exist:
//
//   * create and boot the workers
//   * fan out a request to one worker and await its matching reply
//   * collect worker logs into a bounded ring the Diagnostics screen renders
//   * expose the control SAB to every worker at boot
//
// Two design points worth stating, because they are the ones that get done
// wrong elsewhere:
//
// 1. **One request in flight per worker, correlated by `seq`.** Without the
//    sequence number a reply cannot be matched to its request, and the
//    alternative — assuming FIFO — is not guaranteed across a worker's own
//    async handlers (the GPU worker's adapter request is exactly that case).
//
// 2. **The main thread never blocks.** Part 3.10 says it "never runs emulation
//    or blocking I/O". Every call below is async and yields, which is what keeps
//    the shell responsive while workers saturate every core.

import {
  ControlBlock,
  WorkerKind,
  WORKER_LABEL,
  type ArenaGrown,
  type BootOk,
  type GpuAdapterReply,
  type TelemetryReply,
  type WorkerLog,
  type WorkerRequest,
  type WorkerResponse,
  type DistributiveOmitSeq,
} from './protocol';
import type { RegionInfo } from '../core/instantiate';

// Worker entry URLs. See WORKER_URLS below for why these are imported rather than
// built with `new URL(..., import.meta.url)`.
import cpuWorkerUrl from '../workers/cpu.worker.ts?worker&url';
import gpuWorkerUrl from '../workers/gpu.worker.ts?worker&url';
import audioWorkerUrl from '../workers/audio.worker.ts?worker&url';
import ioWorkerUrl from '../workers/io.worker.ts?worker&url';

export interface LogEntry {
  id: number;
  kind: WorkerKind;
  level: WorkerLog['level'];
  message: string;
  /** performance.now() at arrival. */
  at: number;
}

export interface WorkerBootInfo {
  kind: WorkerKind;
  booted: boolean;
  abiVersion?: number;
  buildId?: string;
  features?: number;
  arenaBytes?: number;
  arenaUsedBytes?: number;
  isSharedMemory?: boolean;
  regions?: RegionInfo[];
  error?: { message: string; remedy?: string };
}

/** Per-worker arena sizes, from Part 3.9's shared-memory region list. */
const ARENA_BYTES: Record<WorkerKind, number> = {
  [WorkerKind.Cpu]: 1024 * 1024 * 1024, // owns guest RAM + TLB + CPU contexts
  [WorkerKind.Gpu]: 512 * 1024 * 1024, // render targets + NVN ring
  [WorkerKind.Audio]: 128 * 1024 * 1024, // audren PCM ring
  [WorkerKind.Io]: 256 * 1024 * 1024, // save data, save states, block reader
  [WorkerKind.AudioWorklet]: 0,
};

const WORKER_ORDER = [WorkerKind.Cpu, WorkerKind.Gpu, WorkerKind.Audio, WorkerKind.Io];

/**
 * Worker entry URLs, one static import per worker.
 *
 * The `?worker&url` suffix makes Vite bundle each worker as its own chunk and hand
 * back the emitted URL. Two alternatives were tried and are worse:
 *
 *   * `new Worker(new URL('./x.worker.ts', import.meta.url), ...)` - Vite rewrites
 *     the URL, but only when the literal is recognisable at build time. Inside a
 *     lookup table keyed by `WorkerKind` it silently degrades to emitting the raw
 *     `.ts` file as an asset and inlining it as a base64 `data:` URL. The worker
 *     then starts and fails on MIME type, which looks nothing like the cause.
 *
 *   * Importing the default export from `?worker` - that exports a Worker
 *     *constructor*, which hardcodes the options and gives up the single
 *     construction site here where the name and error handling are set up.
 */
const WORKER_URLS: Record<number, string> = {
  [WorkerKind.Cpu]: cpuWorkerUrl,
  [WorkerKind.Gpu]: gpuWorkerUrl,
  [WorkerKind.Audio]: audioWorkerUrl,
  [WorkerKind.Io]: ioWorkerUrl,
};

const LOG_RING_CAPACITY = 500;

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class WorkerHost {
  private readonly workers = new Map<WorkerKind, Worker>();
  private readonly pending = new Map<WorkerKind, Map<number, Pending>>();
  private readonly boots = new Map<WorkerKind, WorkerBootInfo>();
  private readonly logs: LogEntry[] = [];
  private readonly listeners = new Set<(logs: LogEntry[]) => void>();
  private readonly messageListeners = new Set<(msg: WorkerResponse) => void>();
  private readonly control: ControlBlock | null;
  private readonly ringSab: SharedArrayBuffer | undefined;

  private seq = 0;
  private nextLogId = 0;

  /**
   * The core directory as an absolute URL.
   *
   * Workers need this because a relative specifier inside a worker resolves
   * against the worker script's own location, not the document's. Computed once
   * and cached.
   */
  private absCoreUrl: string | null = null;

  private absCoreBaseUrl(): string {
    if (this.absCoreUrl === null) {
      this.absCoreUrl = new URL(this.coreBaseUrl, self.location.href).href;
    }
    return this.absCoreUrl;
  }

  constructor(
    private readonly coreBaseUrl: string,
    /**
     * The audio ring, allocated by the caller.
     *
     * Passed in rather than created here because the main thread must hand the
     * same SharedArrayBuffer to the AudioWorklet, and the worklet can only be
     * constructed where `AudioContext` exists. Creating the ring here and reading
     * it back out of the worker would give two unrelated buffers.
     */
    ringSab?: SharedArrayBuffer,
    private readonly logSink?: (entry: LogEntry) => void,
  ) {
    const sab = WorkerHost.makeControlSab();
    this.control = sab ? new ControlBlock(sab) : null;
    this.ringSab = ringSab;
    for (const kind of WORKER_ORDER) {
      this.boots.set(kind, { kind, booted: false });
      this.pending.set(kind, new Map());
    }
  }

  /**
   * The control SAB, or null when the platform cannot provide one.
   *
   * Returning null rather than throwing matters: the shell should still render
   * and explain the problem when cross-origin isolation is missing, because
   * that is exactly when the user needs to read the diagnostic.
   */
  private static makeControlSab(): SharedArrayBuffer | null {
    if (typeof SharedArrayBuffer !== 'function') return null;
    if (!globalThis.crossOriginIsolated) return null;
    return new SharedArrayBuffer(64);
  }

  get controlBlock(): ControlBlock | null {
    return this.control;
  }

  bootInfo(kind: WorkerKind): WorkerBootInfo {
    return this.boots.get(kind)!;
  }

  allBootInfo(): WorkerBootInfo[] {
    return WORKER_ORDER.map((k) => this.boots.get(k)!);
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  subscribeLogs(fn: (logs: LogEntry[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Observes every worker message, including ones that are not a reply to a
   * pending request.
   *
   * The shell needs this for messages that arrive outside a request/response
   * cycle — a keys summary produced by a user-initiated picker, for instance.
   * Those must not be routed only through `request()`, or the UI would have no
   * way to learn about them.
   */
  subscribeMessages(fn: (msg: WorkerResponse) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  /** Boots every worker and resolves once all have reported, or failed. */
  async bootAll(): Promise<void> {
    await Promise.all(WORKER_ORDER.map((kind) => this.bootOne(kind)));
  }

  async bootOne(kind: WorkerKind): Promise<WorkerBootInfo> {
    const existing = this.workers.get(kind);
    if (existing) return this.boots.get(kind)!;

    const url = WORKER_URLS[kind];
    if (!url) {
      throw new Error(`No worker module is registered for ${WORKER_LABEL[kind] ?? kind}.`);
    }

    const worker = new Worker(url, {
      type: 'module',
      name: `switch-web-${WORKER_LABEL[kind].toLowerCase()}`,
    });
    this.workers.set(kind, worker);

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.route(kind, event.data);
    });

    worker.addEventListener('error', (event) => {
      const info = this.boots.get(kind)!;
      info.booted = false;
      info.error = {
        message: event.message || 'The worker failed to start.',
        remedy:
          'A worker that fails to construct usually means the built bundle is inconsistent. Rebuild, and confirm the COOP/COEP headers are still set.',
      };
      this.pushLog({
        id: this.nextLogId++,
        kind,
        level: 'error',
        message: info.error.message,
        at: performance.now(),
      });
      // Reject anything waiting, or the shell hangs on a boot that will never
      // complete.
      this.rejectAll(kind, new Error(info.error.message));
    });

    const info = this.boots.get(kind)!;

    try {
      const reply = await this.request(kind, {
        type: 'boot',
        kind,
        arenaBytes: ARENA_BYTES[kind],
        // Resolved to an absolute URL before it crosses the boundary. A relative
        // path inside a worker resolves against the *worker script's* URL
        // (assets/<name>-<hash>.js), not the document, so "./core.wasm" would be
        // looked up under assets/ and 404 - while the main thread loads the same
        // path fine. Making it absolute removes the ambiguity entirely.
        coreBaseUrl: this.absCoreBaseUrl(),
        control: this.control?.sab,
        ringSab: kind === WorkerKind.Audio ? this.ringSab : undefined,
      } as WorkerRequest, 30_000);

      const booted = reply as BootOk;
      info.booted = true;
      info.abiVersion = booted.abiVersion;
      info.buildId = booted.buildId;
      info.features = booted.features;
      info.arenaBytes = booted.arenaBytes;
      info.arenaUsedBytes = booted.arenaUsedBytes;
      info.isSharedMemory = booted.isSharedMemory;
      info.regions = booted.regions;

      this.pushLog({
        id: this.nextLogId++,
        kind,
        level: 'info',
        message:
          `${WORKER_LABEL[kind]} booted: ${booted.buildId} (ABI v${booted.abiVersion}), ` +
          `arena ${booted.arenaBytes} bytes${booted.isSharedMemory ? ', shared' : ', NOT shared'}.`,
        at: performance.now(),
      });
    } catch (error) {
      info.error = {
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }

    return info;
  }

  /** Sends a request and resolves with the worker's reply. */
  /**
   * Sends a request and resolves with the worker's reply.
   *
   * The parameter type distributes `seq` out over the union *member by member*.
   * `Omit<WorkerRequest, 'seq'>` is not distributive, so it collapses to the
   * keys common to every variant, and a call like
   * `{ type: 'grow-arena', deltaBytes }` is rejected even though it is valid.
   * The explicit conditional type is what makes the union survive.
   */
  request(
    kind: WorkerKind,
    msg: DistributiveOmitSeq<WorkerRequest>,
    timeoutMs = 10_000,
  ): Promise<WorkerResponse> {
    const worker = this.workers.get(kind);
    if (!worker) {
      return Promise.reject(new Error(`${WORKER_LABEL[kind]} worker has not been created.`));
    }

    const seq = msg.seq ?? this.seq++;
    const full: WorkerRequest = { ...msg, seq } as WorkerRequest;

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = self.setTimeout(() => {
        this.pending.get(kind)?.delete(seq);
        reject(new Error(`${WORKER_LABEL[kind]} did not answer '${full.type}' within ${timeoutMs} ms.`));
      }, timeoutMs) as unknown as number;

      this.pending.get(kind)!.set(seq, { resolve, reject, timer });
      worker.postMessage(full);
    });
  }

  /** Part 6 Phase 0 gate: full main -> worker -> main round-trip timing. */
  async measureRoundTrip(samples = 64): Promise<{ kind: WorkerKind; p50: number; p95: number; max: number }> {
    const cpu = this.boots.get(WorkerKind.Cpu)!;
    if (!cpu.booted) throw new Error('The CPU worker must boot before measuring round-trip latency.');

    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      await this.request(WorkerKind.Cpu, { type: 'ping', seq: i });
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    return {
      kind: WorkerKind.Cpu,
      p50: latencies[Math.floor(samples * 0.5)]!,
      p95: latencies[Math.floor(samples * 0.95)]!,
      max: latencies[samples - 1]!,
    };
  }

  async telemetry(kind: WorkerKind): Promise<TelemetryReply> {
    return (await this.request(kind, { type: 'telemetry', seq: 0 })) as TelemetryReply;
  }

  async adapter(): Promise<GpuAdapterReply> {
    return (await this.request(WorkerKind.Gpu, { type: 'request-adapter', seq: 0 })) as GpuAdapterReply;
  }

  async growArena(kind: WorkerKind, deltaBytes: number): Promise<ArenaGrown> {
    return (await this.request(kind, { type: 'grow-arena', deltaBytes, seq: 0 })) as ArenaGrown;
  }

  /**
   * Opens the directory picker and persists the handle.
   *
   * Must be called from a user gesture: `showDirectoryPicker` rejects otherwise,
   * and that rejection is what the browser wants, not a bug to work around.
   */
  async pickUserFolder(): Promise<FileSystemDirectoryHandle | null> {
    if (typeof showDirectoryPicker !== 'function') {
      throw new Error(
        'This browser does not implement showDirectoryPicker. Saves would fall back to IndexedDB, ' +
          'which is opaque and hard to back up. See the capability report for details.',
      );
    }
    try {
      const handle = await showDirectoryPicker({ id: 'switch-web', mode: 'readwrite' });

      // Persist the handle so a reload does not require re-picking. This is the
      // one thing IndexedDB is used for on the primary path, and it is exactly
      // what IndexedDB is good at: an opaque, durable pointer to a resource the
      // user granted. Directory contents never enter origin storage (Part 0).
      const { persistDirectoryHandle } = await import('./folderHandle');
      await persistDirectoryHandle(handle);

      await this.request(WorkerKind.Io, { type: 'probe-folder', seq: 0 });
      this.pushLog({
        id: this.nextLogId++,
        kind: WorkerKind.Io,
        level: 'info',
        message: `User folder "${handle.name}" selected.`,
        at: performance.now(),
      });
      return handle;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    for (const [kind, worker] of this.workers) {
      try {
        this.request(kind, { type: 'shutdown', seq: 0 }, 1000).catch(() => undefined);
      } catch {
        // Already gone.
      }
      worker.terminate();
    }
    this.workers.clear();
  }

  // --- internals ---------------------------------------------------------

  private route(kind: WorkerKind, msg: WorkerResponse): void {
    // Every message is offered to observers first. A reply may also be awaited
    // by a pending request, and both consumers need to see it.
    for (const fn of this.messageListeners) fn(msg);

    switch (msg.type) {
      case 'pong':
      case 'telemetry':
      case 'adapter':
      case 'arena-grown':
      case 'folder-summary':
      case 'keys-summary': {
        // These are replies: resolve the pending request with the matching seq.
        // These are replies: resolve the pending request with the matching seq.
        const waiter = msg.seq !== undefined ? this.pending.get(kind)?.get(msg.seq) : undefined;
        if (waiter) {
          this.pending.get(kind)!.delete(msg.seq!);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        } else if (msg.type === 'pong') {
          // Unsolicited pong: a worker-side self-test rather than our request.
          this.pushLog({
            id: this.nextLogId++,
            kind,
            level: 'info',
            message: `worker self-test ping seq=${msg.seq} in ${msg.workerElapsedMs.toFixed(4)} ms`,
            at: performance.now(),
          });
        }
        return;
      }

      case 'booted':
        // Handled by bootOne, which awaits the boot request's reply.
        return;

      case 'error': {
        const info = this.boots.get(kind)!;
        if (msg.fatal) {
          info.booted = false;
          info.error = { message: msg.message, remedy: msg.remedy };
          this.rejectAll(kind, new Error(msg.message));
        }
        this.pushLog({
          id: this.nextLogId++,
          kind,
          level: 'error',
          message: msg.remedy ? `${msg.message}\n  -> ${msg.remedy}` : msg.message,
          at: performance.now(),
        });
        return;
      }

      case 'audio-status':
        // Unsolicited periodic report. Folded into the log so it is visible in
        // Diagnostics without needing a dedicated subscription, and only when
        // something is wrong: a healthy 100%-full ring every second would be
        // noise, whereas an underrun is exactly the thing to notice.
        if (msg.underruns > 0 || msg.fillPercent < 25) {
          this.pushLog({
            id: this.nextLogId++,
            kind,
            level: msg.underruns > 0 ? 'warn' : 'info',
            message:
              `audio ring ${msg.fillPercent.toFixed(0)}% full ` +
              `(${msg.fillFrames}/${msg.ringCapacityFrames} frames), ` +
              `${msg.underruns} underrun${msg.underruns === 1 ? '' : 's'}`,
            at: performance.now(),
          });
        }
        return;

      case 'log':
        this.pushLog({ id: this.nextLogId++, kind, level: msg.level, message: msg.message, at: performance.now() });
        return;

      default: {
        // An unknown message type is a protocol drift. Surfacing it beats
        // silently dropping data the UI is waiting for.
        this.pushLog({
          id: this.nextLogId++,
          kind,
          level: 'warn',
          message: `Unrecognised message type '${String((msg as { type: string }).type)}' from ${WORKER_LABEL[kind]}.`,
          at: performance.now(),
        });
      }
    }
  }

  private rejectAll(kind: WorkerKind, error: Error): void {
    const waiters = this.pending.get(kind);
    if (!waiters) return;
    for (const [, waiter] of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  }

  private pushLog(entry: LogEntry): void {
    this.logs.push(entry);
    // Bounded ring: a long session must not grow the log without limit.
    if (this.logs.length > LOG_RING_CAPACITY) this.logs.splice(0, this.logs.length - LOG_RING_CAPACITY);
    this.logSink?.(entry);
    for (const fn of this.listeners) fn(this.logs);
  }
}
