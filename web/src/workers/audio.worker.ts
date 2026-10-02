// web/src/workers/audio.worker.ts
//
// Audio worker (Part 3.6).
//
// What lives here is the *producer* half of the audio path: the emulated audren
// renderer's output, written into a shared SPSC ring. What does not live here is
// the Web Audio API, because `AudioContext` does not exist in a dedicated worker.
// The AudioWorklet, which owns the ring's read side and the device connection, is
// created on the main thread by web/src/platform/audio.ts.
//
// At Phase 0 the renderer is a 440 Hz placeholder. That is a deliberate choice
// rather than a stub: it makes the ring's fill behaviour, the wrap arithmetic, and
// the underrun path all observable, and the Phase 3 audren DSP drops in behind
// `write()` without any structural change. What is being verified here is the
// plumbing, not the sound.
//
// It also reports underruns. Part 3.6 names underruns as the failure mode and
// Part 6 Phase 3 gates on a 30-minute session with none, so the counter exists
// from the first run rather than being added when it is needed.

import { bootWorker, installCommonHandlers, reportError, log, type WorkerContext } from './common';
import { WorkerKind } from '../platform/protocol';
import { AudioRingProducer, ringFill, ringUnderruns, GUEST_SAMPLE_RATE, RING_TOTAL_FRAMES, HEADER } from '../platform/audio';

const ctx: WorkerContext = { kind: WorkerKind.Audio };

/**
 * How often to top up the ring.
 *
 * 20 ms is well under the time the worklet takes to drain half the ring, so the
 * producer never has to write more than a fraction of the buffer per tick, which
 * keeps each write short enough to avoid a visible stall.
 */
const FILL_INTERVAL_MS = 20;

let producer: AudioRingProducer | null = null;
let fillTimer: number | null = null;
let reportTimer: number | null = null;

function stopAudio(): void {
  if (fillTimer !== null) {
    clearInterval(fillTimer);
    fillTimer = null;
  }
  if (reportTimer !== null) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  producer = null;
}

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

installCommonHandlers(ctx);

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg?.type !== 'boot') return;

  try {
    await bootWorker(WorkerKind.Audio, msg);
  } catch (error) {
    reportError(WorkerKind.Audio, error);
    return;
  }

  // --- ring wiring --------------------------------------------------------
  //
  // The ring is allocated on the main thread and handed over on the boot message,
  // because the main thread has to give the same SharedArrayBuffer to the
  // AudioWorklet. Two handles to one buffer is the only arrangement that lets the
  // producer and the consumer be in different threads.

  const ringSab = msg.ringSab as SharedArrayBuffer | undefined;
  if (!ringSab) {
    log(
      WorkerKind.Audio,
      'warn',
      'No audio ring was supplied. This is expected when the platform is not cross-origin isolated, ' +
        'in which case SharedArrayBuffer does not exist and audio output is disabled.',
    );
    return;
  }

  const ring = {
    sab: ringSab,
    header: new Int32Array(ringSab, 0, 8),
    samples: new Float32Array(ringSab, 32),
  };

  producer = new AudioRingProducer(ring);

  fillTimer = self.setInterval(() => {
    producer?.fill();
  }, FILL_INTERVAL_MS) as unknown as number;

  reportTimer = self.setInterval(() => {
    const fill = ringFill(ring);
    const underruns = ringUnderruns(ring);
    post({
      type: 'audio-status',
      kind: WorkerKind.Audio,
      fillFrames: fill,
      ringCapacityFrames: RING_TOTAL_FRAMES,
      underruns,
      fillPercent: (fill / RING_TOTAL_FRAMES) * 100,
      guestSampleRate: GUEST_SAMPLE_RATE,
      primed: Atomics.load(ring.header, HEADER.primed) === 1,
    });
  }, 1000) as unknown as number;

  log(
    WorkerKind.Audio,
    'info',
    `Audio producer running at ${GUEST_SAMPLE_RATE} Hz into a ${RING_TOTAL_FRAMES}-frame ring ` +
      `(${(RING_TOTAL_FRAMES / GUEST_SAMPLE_RATE * 1000).toFixed(0)} ms of slack). ` +
      `The AudioWorklet owns the read side and the device connection.`,
  );
});

self.addEventListener('close', () => stopAudio());
