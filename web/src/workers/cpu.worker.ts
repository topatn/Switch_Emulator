// web/src/workers/cpu.worker.ts
//
// CPU worker (Part 3.9). In Phase 0 this worker exists to prove the topology:
// it owns the largest arena, it is the one that would own guest RAM, and it is
// the worker whose round-trip latency the Phase 0 gate measures.
//
// Everything below the boot sequence is intentionally not implemented yet.
// Part 3.2.4 Topology 1 is the v1 shape — four guest cores interleaved on one
// host thread — and that needs the AArch64 interpreter (Phase 1) and the WASM
// JIT (Phase 2) to be meaningful. Writing a stub dispatch loop now would create
// a second, wrong implementation to delete later.

import { bootWorker, installCommonHandlers, reportError, type WorkerContext } from './common';
import { WorkerKind, WORKER_LABEL } from '../platform/protocol';

const ctx: WorkerContext = { kind: WorkerKind.Cpu };

installCommonHandlers(ctx);

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg?.type !== 'boot') return;

  try {
    // The caller's own ctx is passed in, so `ctx.info` below is populated.
    await bootWorker(ctx, msg);
  } catch (error) {
    reportError(WorkerKind.Cpu, error);
    return;
  }

  const info = ctx.info;
  if (!info) {
    reportError(WorkerKind.Cpu, new Error('Boot reported success but no core was attached.'));
    return;
  }

  // The Phase 0 gate's latency budget: "one round trip main->worker->main < 1 ms
  // (validates SAB/Atomics path)". This worker is the one that matters because it
  // owns guest RAM, so it exercises the widest set of pages.
  const SAMPLES = 64;
  const latencies: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const echoed = info.exports.sw_core_ping(i);
    const dt = performance.now() - t0;
    if (echoed !== i) {
      reportError(WorkerKind.Cpu, new Error(`ping echo mismatch: sent ${i}, got ${echoed}`));
      return;
    }
    latencies.push(dt);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(SAMPLES * 0.5)]!;
  const p95 = latencies[Math.floor(SAMPLES * 0.95)]!;
  const max = latencies[SAMPLES - 1]!;

  // Report into shared memory so the shell can read it without another message.
  info.exports.sw_core_note_roundtrip(BigInt(Math.round(p95 * 1e6)));

  (self as unknown as Worker).postMessage({
    type: 'log',
    kind: WorkerKind.Cpu,
    level: 'info',
    message:
      `${WORKER_LABEL[WorkerKind.Cpu]} round trip over ${SAMPLES} samples: ` +
      `p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms, max ${max.toFixed(4)} ms.`,
  });

  (self as unknown as Worker).postMessage({
    type: 'log',
    kind: WorkerKind.Cpu,
    level: 'info',
    message:
      p95 < 1
        ? 'Phase 0 latency gate PASSED (p95 < 1 ms).'
        : `Phase 0 latency gate FAILED: p95 was ${p95.toFixed(4)} ms, budget is 1 ms.`,
  });

  // Not yet implemented, stated plainly rather than implied by silence:
  //   - AArch64 interpreter      (Phase 1)
  //   - MMU / TLB / page tables  (Phase 1)
  //   - WASM-emitting JIT        (Phase 2)
  //   - HLE kernel + services    (Phase 2)
  // See ARCHITECTURE.md Part 6 for the gate sequence.
});
