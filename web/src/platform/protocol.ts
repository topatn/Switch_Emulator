// web/src/platform/protocol.ts
//
// The message contract between the main thread and the five workers.
//
// Part 3.9's rule, applied literally: **hot paths do not go through postMessage.**
// HID state, telemetry, and command rings live in a SharedArrayBuffer with
// Atomics; `postMessage` carries only lifecycle, errors, and low-rate status.
// This file therefore has two halves:
//   - a typed request/response protocol for cold messages (discriminated unions)
//   - the SAB layout and accessor helpers for hot state
//
// A discriminated union per worker (rather than one generic message type) is
// deliberate: it makes an unhandled command ID a compile error in the handler
// and a visible gap in the switch, instead of a silent no-op.

import type { RegionInfo } from '../core/instantiate';

export const SAB_LAYOUT_VERSION = 1;

/**
 * Byte offsets into the single control SAB (Part 3.9's "progress & flags
 * (Atomics)" region).
 *
 * Everything here is a *control* signal. Bulk data moves through the per-worker
 * arenas, not through this block. Keeping the two separate is what lets the
 * control block stay cache-line sized and lock-free.
 *
 * The first 32 bytes are the atomics "control plane"; the rest is a region
 * directory the main thread fills in once at attach time and then reads.
 */
export const CONTROL_OFFSETS = {
  /** Bumped by whoever changes the layout. Workers refuse a mismatch. */
  layoutVersion: 0,
  /** Atomics: 0 = detached, 1 = attached. */
  attachState: 4,
  /** Atomics: incremented per frame by the CPU worker. */
  frameEpoch: 8,
  /** Atomics: 0 = running, 1 = paused, 2 = stopping. */
  runState: 12,
  /** Atomics: worker availability bitmap, one bit per worker kind. */
  workerMask: 16,
  /** u32: worker kind of the last worker to report. */
  lastReporter: 20,
  /** u64: timestamp of the last frame boundary (core monotonic ns). */
  lastFrameNs: 24,
} as const;

export const CONTROL_BYTES = 64;

export enum WorkerKind {
  Cpu = 1,
  Gpu = 2,
  Audio = 3,
  Io = 4,
  /** The AudioWorklet is not a Worker; it has no SAB of its own. */
  AudioWorklet = 8,
}

export const WORKER_LABEL: Record<WorkerKind, string> = {
  [WorkerKind.Cpu]: 'CPU',
  [WorkerKind.Gpu]: 'GPU',
  [WorkerKind.Audio]: 'Audio',
  [WorkerKind.Io]: 'I/O',
  [WorkerKind.AudioWorklet]: 'AudioWorklet',
};

// --- main -> worker (cold) -------------------------------------------------

export interface BootRequest {
  type: 'boot';
  kind: WorkerKind;
  arenaBytes: number;
  /** Directory holding core.wasm / core.js, as an absolute URL. */
  coreBaseUrl: string;
  /** The control SAB, if the platform supports sharing. */
  control?: SharedArrayBuffer;
  /**
   * The audio SPSC ring, for the audio worker only.
   *
   * Allocated on the main thread and passed down because the main thread also has
   * to hand the same buffer to the AudioWorklet: the producer and the consumer of
   * a ring must be in different threads, and the AudioWorklet can only be created
   * where `AudioContext` exists, which is the main thread.
   */
  ringSab?: SharedArrayBuffer;
}

export interface PingRequest {
  type: 'ping';
  /** Echoed back in the response; used to pair requests with replies. */
  seq: number;
}

export interface TelemetryRequest {
  type: 'telemetry';
  seq: number;
}

export interface GrowArenaRequest {
  type: 'grow-arena';
  deltaBytes: number;
  seq: number;
}

export interface ShutdownRequest {
  type: 'shutdown';
}

export interface RequestGpuAdapter {
  type: 'request-adapter';
  seq: number;
}

/**
 * I/O worker requests (Part 3.8).
 *
 * These are on the cold protocol even though they look like storage operations:
 * they run rarely (user action, or once at boot) and their results are advisory
 * UI state, not frame-critical data. Save *data* will use its own ring in the
 * CPU worker once Phase 2 lands, because that path is latency-sensitive.
 */
export interface ProbeFolderRequest {
  type: 'probe-folder';
  seq: number;
}

export interface RestoreFolderRequest {
  type: 'restore-folder';
  seq: number;
}

export interface PickKeysRequest {
  type: 'pick-keys';
  seq: number;
}

export interface FolderSummaryMessage {
  type: 'folder-summary';
  seq: number;
  name: string;
  permission: FileSystemPermissionState;
  entries: Array<{ name: string; kind: 'file' | 'directory' }>;
  present: string[];
  missing: string[];
}

/**
 * A keys-file report. Deliberately carries counts and key *names* only, never
 * values (Part 0: "Never display or log key material").
 */
export interface KeysSummaryMessage {
  type: 'keys-summary';
  seq: number;
  fileName: string;
  byteLength: number;
  valid: boolean;
  keyLineCount: number;
  rightsIdCount: number;
  families: string[];
  problems: string[];
}

export type WorkerRequest =
  | BootRequest
  | PingRequest
  | TelemetryRequest
  | GrowArenaRequest
  | ShutdownRequest
  | RequestGpuAdapter
  | ProbeFolderRequest
  | RestoreFolderRequest
  | PickKeysRequest;

// --- worker -> main (cold) -------------------------------------------------

export interface BootOk {
  type: 'booted';
  kind: WorkerKind;
  abiVersion: number;
  buildId: string;
  features: number;
  arenaBytes: number;
  arenaUsedBytes: number;
  isSharedMemory: boolean;
  regions: RegionInfo[];
}

export interface PongMessage {
  type: 'pong';
  kind: WorkerKind;
  seq: number;
  /** Round-trip time for this specific hop, measured on the worker. */
  workerElapsedMs: number;
}

export interface TelemetryReply {
  type: 'telemetry';
  kind: WorkerKind;
  seq: number;
  abiVersion: number;
  initState: number;
  arenaBytes: number;
  arenaUsedBytes: number;
  lastRoundtripNs: bigint;
  monotonicNs: bigint;
}

export interface GpuAdapterReply {
  type: 'adapter';
  seq: number;
  available: boolean;
  vendor?: string;
  architecture?: string;
  description?: string;
  /** False when we are on a fallback adapter (software or low-power). */
  isFallback?: boolean;
  maxBufferSize?: number;
  maxTextureDimension2D?: number;
  reason?: string;
}

export interface ArenaGrown {
  type: 'arena-grown';
  kind: WorkerKind;
  seq: number;
  arenaBytes: number;
  /** True when the buffer detached, i.e. all views must be re-derived. */
  bufferDetached: boolean;
}

export interface WorkerFailed {
  type: 'error';
  kind: WorkerKind;
  message: string;
  remedy?: string;
  fatal: boolean;
}

export interface WorkerLog {
  type: 'log';
  kind: WorkerKind;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** Periodic audio health report from the audio worker (Part 3.6). */
export interface AudioStatusMessage {
  type: 'audio-status';
  kind: WorkerKind;
  fillFrames: number;
  ringCapacityFrames: number;
  fillPercent: number;
  underruns: number;
  guestSampleRate: number;
  primed: boolean;
}

export type WorkerResponse =
  | BootOk
  | PongMessage
  | TelemetryReply
  | GpuAdapterReply
  | ArenaGrown
  | FolderSummaryMessage
  | KeysSummaryMessage
  | AudioStatusMessage
  | WorkerFailed
  | WorkerLog;

// --- control block accessors ---------------------------------------------

/**
 * Lock-free control block writer.
 *
 * Part 3.9's Atomics discipline: reserve Atomics for cross-thread signalling.
 * These are exactly that — indices, flags, epoch counters — so every one of them
 * is a genuine publish/consume point.
 */
export class ControlBlock {
  private readonly i32: Int32Array;
  private readonly ctrl: BigUint64Array;
  private readonly bytes: Uint8Array;

  constructor(readonly sab: SharedArrayBuffer) {
    this.i32 = new Int32Array(sab, 0, 16);
    this.ctrl = new BigUint64Array(sab, 0, 8);
    this.bytes = new Uint8Array(sab);
    this.i32[CONTROL_OFFSETS.layoutVersion >>> 2] = SAB_LAYOUT_VERSION;
  }

  get layoutVersion(): number {
    return Atomics.load(this.i32, CONTROL_OFFSETS.layoutVersion >>> 2);
  }

  /** Runs a callback once the SAB layout matches what this worker expects. */
  assertLayout(): void {
    const v = this.layoutVersion;
    if (v !== SAB_LAYOUT_VERSION) {
      throw new Error(
        `Shared control block layout mismatch: worker expects v${SAB_LAYOUT_VERSION}, found v${v}. ` +
          'All workers and the shell must be built from the same source.',
      );
    }
  }

  markAttached(kind: WorkerKind): void {
    Atomics.or(this.i32, CONTROL_OFFSETS.workerMask >>> 2, kind);
    Atomics.store(this.i32, CONTROL_OFFSETS.lastReporter >>> 2, kind);
    Atomics.store(this.i32, CONTROL_OFFSETS.attachState >>> 2, 1);
  }

  markDetached(kind: WorkerKind): void {
    Atomics.and(this.i32, CONTROL_OFFSETS.workerMask >>> 2, ~kind);
  }

  isAttached(): boolean {
    return Atomics.load(this.i32, CONTROL_OFFSETS.attachState >>> 2) === 1;
  }

  workerMask(): number {
    return Atomics.load(this.i32, CONTROL_OFFSETS.workerMask >>> 2);
  }

  setRunState(state: 0 | 1 | 2): void {
    Atomics.store(this.i32, CONTROL_OFFSETS.runState >>> 2, state);
  }

  runState(): 0 | 1 | 2 {
    return Atomics.load(this.i32, CONTROL_OFFSETS.runState >>> 2) as 0 | 1 | 2;
  }

  publishFrame(monotonicNs: bigint): void {
    // Order matters: the frame epoch is the release, the timestamp the payload.
    // Storing the timestamp first means a reader that observes the new epoch is
    // guaranteed to see the matching timestamp.
    Atomics.store(this.ctrl, CONTROL_OFFSETS.lastFrameNs >>> 3, monotonicNs);
    Atomics.add(this.i32, CONTROL_OFFSETS.frameEpoch >>> 2, 1);
  }

  frameEpoch(): number {
    return Atomics.load(this.i32, CONTROL_OFFSETS.frameEpoch >>> 2);
  }

  lastFrameNs(): bigint {
    return Atomics.load(this.ctrl, CONTROL_OFFSETS.lastFrameNs >>> 3);
  }

  /** Debug helper for the diagnostics panel. */
  raw(): Uint8Array {
    return this.bytes;
  }
}

export function isShared(sab: ArrayBufferLike): sab is SharedArrayBuffer {
  return typeof SharedArrayBuffer === 'function' && sab instanceof SharedArrayBuffer;
}

/**
 * `seq`-less version of a request union, distributed over each member.
 *
 * Built-in `Omit<A | B, K>` does not distribute: it collapses to the keys the
 * members share, which for a discriminated union is just `type`. Wrapping it in a
 * naked conditional type restores the union, which is what lets a caller pass
 * `{ type: 'grow-arena', deltaBytes }` and have `deltaBytes` be accepted.
 */
export type DistributiveOmitSeq<T> = T extends WorkerRequest ? Omit<T, 'seq'> & { seq?: number } : never;
