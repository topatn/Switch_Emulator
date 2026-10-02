// web/src/platform/audio.ts
//
// The audio path's thread topology (Part 3.6).
//
// The document describes three stages:
//   audren DSP (audio worker) -> SPSC ring (SAB) -> AudioWorklet -> speakers
//
// One of those stages cannot live where you would first put it, and the reason is
// worth writing down because it is a platform fact rather than a design choice:
//
// **AudioContext does not exist in a dedicated worker.** It is exposed on `window`
// only. An `AudioWorkletNode` can therefore only be constructed on the main
// thread, and the main thread is the only place that can own the object feeding
// the speakers. That gives the corrected split:
//
//   main thread    AudioContext + AudioWorkletNode + device connection
//                  -> reads the ring, resamples 48 kHz to the device rate,
//                     counts underruns. No DSP.
//   audio worker   the audren renderer itself
//                  -> fills the ring with 48 kHz frames. No Web Audio API.
//
// This preserves the property Part 3.6 actually cares about: the DSP is nowhere
// near the OS render thread, so a JIT pause or a GC pause cannot cause an audible
// glitch in it. The worklet does only cheap work, which is what makes that
// guarantee hold.
//
// The two sides coordinate through the ring header (four Int32 words: write
// index, read index, underrun count, frames played) and the sample buffer, both in
// one SharedArrayBuffer.

/** Ring geometry from Part 3.6: 8 x 4096-frame buffers, generously sized. */
export const RING_FRAMES = 4096;
export const RING_BUFFERS = 8;
export const RING_TOTAL_FRAMES = RING_FRAMES * RING_BUFFERS;

/** The guest render rate. Fixed by the hardware, not a preference. */
export const GUEST_SAMPLE_RATE = 48000;

/** Ring header word offsets, in Int32 elements. */
export const HEADER = {
  writeIndex: 0,
  readIndex: 1,
  underruns: 2,
  framesPlayed: 3,
  /** Set to 1 by the producer once the ring has been pre-filled with silence. */
  primed: 4,
} as const;

export const HEADER_WORDS = 8;
export const HEADER_BYTES = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;

/** Interleaved stereo f32 frames: 2 samples per frame. */
export const SAMPLE_COUNT = RING_TOTAL_FRAMES * 2;
export const SAMPLE_BYTES = SAMPLE_COUNT * Float32Array.BYTES_PER_ELEMENT;

export interface AudioRing {
  sab: SharedArrayBuffer;
  header: Int32Array;
  samples: Float32Array;
}

/**
 * Creates the shared ring.
 *
 * `SharedArrayBuffer` is required, which is another consequence of Part 3.9's
 * cross-origin isolation requirement: the producer (worker) and the consumer
 * (worklet) are different threads, so the buffer between them has to be shared.
 */
export function createAudioRing(): AudioRing | null {
  if (typeof SharedArrayBuffer !== 'function') return null;
  if (!globalThis.crossOriginIsolated) return null;

  const sab = new SharedArrayBuffer(HEADER_BYTES + SAMPLE_BYTES);
  const ring: AudioRing = {
    sab,
    header: new Int32Array(sab, 0, HEADER_WORDS),
    samples: new Float32Array(sab, HEADER_BYTES),
  };

  // Part 3.6: "pre-filled with silence at startup so the worklet never starves
  // before the first frame." Half the ring is enough to cover the gap between
  // context creation and the first audren output, and it means the worklet can
  // start before the audio worker has produced anything.
  const prefill = RING_TOTAL_FRAMES / 2;
  ring.samples.fill(0, 0, prefill * 2);
  Atomics.store(ring.header, HEADER.writeIndex, prefill % RING_TOTAL_FRAMES);
  Atomics.store(ring.header, HEADER.primed, 1);

  return ring;
}

/** Frames currently buffered, 0..RING_TOTAL_FRAMES. */
export function ringFill(ring: AudioRing): number {
  const write = Atomics.load(ring.header, HEADER.writeIndex);
  const read = Atomics.load(ring.header, HEADER.readIndex);
  return (write - read + RING_TOTAL_FRAMES) % RING_TOTAL_FRAMES;
}

export function ringUnderruns(ring: AudioRing): number {
  return Atomics.load(ring.header, HEADER.underruns);
}

export function ringFramesPlayed(ring: AudioRing): number {
  return Atomics.load(ring.header, HEADER.framesPlayed);
}

/**
 * The AudioWorklet processor source.
 *
 * Written as a string and instantiated from a Blob so the whole app stays a
 * single static bundle with no extra asset to deploy and no second entry point to
 * keep in sync with this file.
 *
 * Deliberately contains: cursor arithmetic, wrap handling, silence on underrun,
 * and one report per second. Deliberately does *not* contain: any filter, any
 * allocation, any lock, or any call into guest code. Part 3.6's reliability claim
 * is exactly that this function stays trivial.
 */
export const WORKLET_SOURCE = `
class SwitchRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.sab;
    this.header = new Int32Array(sab, 0, ${HEADER_WORDS});
    this.samples = new Float32Array(sab, ${HEADER_BYTES});
    this.total = ${RING_TOTAL_FRAMES};
    this.stopped = false;
    this.startedAt = currentTime;
    this.lastReport = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.stopped = true;
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return !this.stopped;

    const frames = out[0].length;
    const write = Atomics.load(this.header, ${HEADER.writeIndex});
    const read = Atomics.load(this.header, ${HEADER.readIndex});
    const available = (write - read + this.total) % this.total;

    if (available < frames) {
      // Part 3.6 names underruns as the failure mode. Counting them here means
      // the Diagnostics screen can show a rate rather than the user having to
      // hear it.
      Atomics.add(this.header, ${HEADER.underruns}, 1);
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return !this.stopped;
    }

    const channels = out.length;
    for (let i = 0; i < frames; i++) {
      const slot = (read + i) % this.total;
      const base = slot * 2;
      for (let c = 0; c < channels; c++) {
        out[c][i] = this.samples[base + (c < 2 ? c : 1)];
      }
    }

    // Release-store the cursor after the samples it describes.
    Atomics.store(this.header, ${HEADER.readIndex}, (read + frames) % this.total);
    Atomics.add(this.header, ${HEADER.framesPlayed}, frames);

    if (this.lastReport === 0 || currentTime - this.lastReport >= 1) {
      this.lastReport = currentTime;
      const newWrite = Atomics.load(this.header, ${HEADER.writeIndex});
      const newRead = Atomics.load(this.header, ${HEADER.readIndex});
      this.port.postMessage({
        framesPlayed: Atomics.load(this.header, ${HEADER.framesPlayed}),
        underruns: Atomics.load(this.header, ${HEADER.underruns}),
        fill: (newWrite - newRead + this.total) % this.total,
        capacity: this.total,
        elapsed: currentTime - this.startedAt,
        sampleRate: sampleRate,
      });
    }

    return !this.stopped;
  }
}

registerProcessor('switch-ring-processor', SwitchRingProcessor);
`;

export interface AudioStatus {
  state: 'uninitialised' | 'suspended' | 'running' | 'closed' | 'unavailable';
  /** The device's actual rate, which is often 44100 rather than 48000. */
  sampleRate: number | null;
  /** True when the device rate differs from the guest rate, so the worklet resamples. */
  resampling: boolean;
  framesPlayed: number;
  underruns: number;
  fillFrames: number;
  ringCapacityFrames: number;
  elapsedSeconds: number;
}

export const EMPTY_AUDIO_STATUS: AudioStatus = {
  state: 'uninitialised',
  sampleRate: null,
  resampling: false,
  framesPlayed: 0,
  underruns: 0,
  fillFrames: 0,
  ringCapacityFrames: RING_TOTAL_FRAMES,
  elapsedSeconds: 0,
};

/**
 * Main-thread owner of the AudioContext and the worklet.
 *
 * This is the only place in the codebase that touches the Web Audio API, which is
 * the point: there is exactly one object graph that can stall the OS render
 * thread, and it is three functions wide.
 */
export class AudioOutput {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private moduleUrl: string | null = null;
  private last: AudioStatus = EMPTY_AUDIO_STATUS;
  private onStatus: (status: AudioStatus) => void;

  constructor(
    private readonly ring: AudioRing,
    onStatus: (status: AudioStatus) => void,
  ) {
    this.onStatus = onStatus;
  }

  /**
   * Creates the context and worklet.
   *
   * The context is created suspended unless the browser allows it to start. That
   * is the autoplay policy: a context with no user gesture behind it stays
   * suspended until one arrives. Creating it anyway is fine and is what lets the
   * UI show "suspended, click to enable" rather than nothing.
   */
  async start(): Promise<AudioStatus> {
    if (this.context) return this.status();

    if (typeof AudioContext !== 'function') {
      this.last = { ...this.last, state: 'unavailable' };
      this.onStatus(this.last);
      return this.last;
    }

    try {
      // Ask for 48 kHz so the guest rate needs no resampling. A browser may
      // refuse and hand back the hardware rate, which the worklet handles.
      this.context = new AudioContext({
        sampleRate: GUEST_SAMPLE_RATE,
        latencyHint: 'interactive',
      });
    } catch {
      this.context = new AudioContext({ latencyHint: 'interactive' });
    }

    if (!this.context.audioWorklet) {
      this.last = { ...this.last, state: 'unavailable', sampleRate: this.context.sampleRate };
      this.onStatus(this.last);
      return this.last;
    }

    this.moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await this.context.audioWorklet.addModule(this.moduleUrl);
    } finally {
      // Safe to revoke: addModule has already compiled the source.
      URL.revokeObjectURL(this.moduleUrl);
      this.moduleUrl = null;
    }

    this.node = new AudioWorkletNode(this.context, 'switch-ring-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sab: this.ring.sab },
    });

    this.node.port.onmessage = (event: MessageEvent<AudioWorkletReport>) => {
      const report = event.data;
      this.last = {
        state: this.context?.state === 'running' ? 'running' : 'suspended',
        sampleRate: report.sampleRate,
        resampling: Math.abs(report.sampleRate - GUEST_SAMPLE_RATE) > 1,
        framesPlayed: report.framesPlayed,
        underruns: report.underruns,
        fillFrames: report.fill,
        ringCapacityFrames: report.capacity,
        elapsedSeconds: report.elapsed,
      };
      this.onStatus(this.last);
    };

    // A GainNode rather than the worklet's `outputGain`: an AudioWorkletNode has
    // no gain parameter, so volume has to be a node in the graph. It also means
    // muting never requires re-creating the worklet.
    this.gain = this.context.createGain();
    this.gain.gain.value = 1;

    this.node.connect(this.gain);
    this.gain.connect(this.context.destination);

    this.last = { ...this.last, sampleRate: this.context.sampleRate, state: this.context.state as AudioStatus['state'] };
    this.onStatus(this.last);
    return this.last;
  }

  /** Resumes a context suspended by the autoplay policy. Must come from a gesture. */
  async resume(): Promise<AudioStatus> {
    if (!this.context) return this.status();
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        // A resume outside a gesture rejects; the caller retries on the next click.
      }
    }
    this.last = { ...this.last, state: this.context.state as AudioStatus['state'] };
    this.onStatus(this.last);
    return this.last;
  }

  setVolume(volume: number): void {
    if (!this.context || !this.gain) return;
    // A short ramp rather than a step, so a slider drag does not produce zipper
    // noise on every input event.
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)), this.context.currentTime, 0.01);
  }

  status(): AudioStatus {
    return this.last;
  }

  async close(): Promise<void> {
    this.node?.port.postMessage('stop');
    this.node?.disconnect();
    this.node = null;
    this.gain?.disconnect();
    this.gain = null;
    if (this.context) {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.last = { ...EMPTY_AUDIO_STATUS, state: 'closed' };
  }
}

interface AudioWorkletReport {
  framesPlayed: number;
  underruns: number;
  fill: number;
  capacity: number;
  elapsed: number;
  sampleRate: number;
}

/**
 * Producer side, used by the audio worker.
 *
 * Kept in this module so the ring geometry has exactly one definition: the
 * worklet's inlined source, the ring allocation, and the producer all read these
 * constants, so they cannot disagree about where the data is.
 */
export class AudioRingProducer {
  private phase = 0;
  private started = false;

  constructor(
    private readonly ring: AudioRing,
    private readonly toneHz = 440,
  ) {}

  /**
   * Tops the ring up to its target depth.
   *
   * Called on an interval rather than per audio callback: the worklet consumes in
   * device-sized blocks and the producer runs far faster than real time, so the
   * only thing that matters is keeping the buffer above the underrun threshold.
   */
  fill(targetDepth = RING_TOTAL_FRAMES / 2): void {
    const deficit = targetDepth - ringFill(this.ring);
    if (deficit <= 0) return;
    this.write(Math.min(deficit, targetDepth));
    this.started = true;
  }

  /** Writes exactly `frames` frames of the placeholder signal. */
  write(frames: number): void {
    if (frames <= 0) return;
    const total = RING_TOTAL_FRAMES;
    const write = Atomics.load(this.ring.header, HEADER.writeIndex);
    const step = (2 * Math.PI * this.toneHz) / GUEST_SAMPLE_RATE;

    for (let i = 0; i < frames; i++) {
      const slot = (write + i) % total;
      this.ring.samples[slot * 2] = Math.sin(this.phase);
      this.ring.samples[slot * 2 + 1] = Math.sin(this.phase + 0.05);
      this.phase += step;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    }

    // Release publication: the samples above are visible once this lands.
    Atomics.store(this.ring.header, HEADER.writeIndex, (write + frames) % total);
  }

  hasWritten(): boolean {
    return this.started;
  }
}
