// web/src/workers/gpu.worker.ts
//
// GPU worker (Part 3.5/3.9). Phase 0 scope: prove that WebGPU is reachable from
// a worker context and report real adapter information.
//
// This is worth doing in Phase 0 rather than Phase 2 because WebGPU adapter
// availability is the single most environment-dependent requirement in the whole
// project. Part 8.3 answers "Chromium-only for v1" precisely because
// `navigator.gpu` may be missing entirely; if it is missing we want that
// discovered now, not after the JIT works.
//
// The adapter request is deliberately done *here* rather than on the main
// thread: Part 3.9 says the GPU worker owns the WebGPU device and the presentable
// OffscreenCanvas, and requesting the adapter is the first step of that ownership.

import { bootWorker, installCommonHandlers, reportError, log, type WorkerContext } from './common';
import { WorkerKind } from '../platform/protocol';
import type { GpuAdapterReply, RequestGpuAdapter } from '../platform/protocol';

const ctx: WorkerContext = { kind: WorkerKind.Gpu };

/**
 * Requests the WebGPU adapter and normalises the result.
 *
 * `powerPreference: 'high-performance'` is a hint, not a guarantee, and
 * `forceFallbackAdapter` is left false: the architecture already plans for weak
 * GPUs via host resolution scale (Part 3.9's frame budget governor), so
 * silently requesting a software adapter would only hide the real problem.
 */
async function describeAdapter(seq: number): Promise<GpuAdapterReply> {
  const gpu = (navigator as { gpu?: GPU }).gpu;
  if (!gpu) {
    return {
      type: 'adapter',
      seq,
      available: false,
      reason:
        'navigator.gpu is undefined in this worker context. WebGPU is required to present any frame.',
    };
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return {
        type: 'adapter',
        seq,
        available: false,
        reason:
          'requestAdapter() returned null. The browser supports WebGPU but no adapter is available, which usually means hardware acceleration is disabled or blocklisted.',
      };
    }

    const info = adapter.info ?? ({} as GPUAdapterInfo);
    const limits = adapter.limits;

    return {
      type: 'adapter',
      seq,
      available: true,
      vendor: info.vendor || undefined,
      architecture: info.architecture || undefined,
      description: info.description || undefined,
      isFallback: adapter.isFallbackAdapter === true,
      maxBufferSize: limits?.maxBufferSize,
      maxTextureDimension2D: limits?.maxTextureDimension2D,
    };
  } catch (error) {
    return {
      type: 'adapter',
      seq,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

installCommonHandlers(ctx, {
  'request-adapter': async (msg: RequestGpuAdapter) => {
    const reply = await describeAdapter(msg.seq);
    (self as unknown as Worker).postMessage(reply);

    if (reply.available) {
      const weakest = reply.isFallback ? ' (FALLBACK adapter - expect very low performance)' : '';
      log(
        WorkerKind.Gpu,
        reply.isFallback ? 'warn' : 'info',
        `WebGPU adapter ready: ${reply.vendor ?? 'unknown'} ${reply.architecture ?? ''}`.trim() +
          `${weakest}. maxBufferSize=${reply.maxBufferSize ?? 'n/a'}.`,
      );
    } else {
      log(WorkerKind.Gpu, 'error', `WebGPU unavailable: ${reply.reason}`);
    }
  },
});

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg?.type !== 'boot') return;

  try {
    await bootWorker(WorkerKind.Gpu, msg);
  } catch (error) {
    reportError(WorkerKind.Gpu, error);
    return;
  }

  // Probe the adapter during boot so the Library screen can show a real
  // capability verdict without the user asking for it.
  (self as unknown as Worker).postMessage({ type: 'request-adapter', seq: 0 } satisfies RequestGpuAdapter);

  // Not yet implemented (Phase 2 for the NVN command processor and a minimal
  // clear-to-colour backend; Phase 3 for Maxwell -> WGSL translation).
});
