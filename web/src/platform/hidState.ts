// web/src/platform/hidState.ts
//
// The HID state struct (Part 3.7's "compact HID state struct").
//
// Layout is fixed and shared-memory compatible: the CPU worker reads this once
// per emulated-core switch. One writer (the main thread), one reader (the CPU
// worker), and a struct small enough that contention is impossible.
//
//   0x00 u32 buttons          bitmask, see HID_BITS
//   0x04 i16 left stick X    -32768..32767
//   0x06 i16 left stick Y
//   0x08 i16 right stick X
//   0x0a i16 right stick Y
//   0x0c i16 ZL              analog trigger, 0..32767
//   0x0e i16 ZR
//   0x10 u32 gyroValid       0 = gyro report is all zeros (Part 3.7)
//   0x14 u32 frameStamp      the frame this state belongs to
//   0x18 u32 sequence        incremented on every publish
//   0x1c u32 reserved
// Total: 32 bytes, half a cache line.

export const HID_STATE_BYTES = 32;

/**
 * HID button bits, matching the Switch `hid` service's assignment.
 *
 * Defined here rather than in input.ts because this module is the one that
 * encodes the bitmask into shared memory, and the bit positions must not depend
 * on a file that itself imports this one.
 */
export const HID_BITS = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L: 4,
  R: 5,
  ZL: 6,
  ZR: 7,
  Minus: 8,
  Plus: 9,
  LeftStick: 10,
  RightStick: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
  SliderL: 16,
  SliderR: 17,
  SideL: 18,
  SideR: 19,
} as const;

export const HID_OFFSETS = {
  buttons: 0,
  leftX: 4,
  leftY: 6,
  rightX: 8,
  rightY: 10,
  zl: 12,
  zr: 14,
  gyroValid: 16,
  frameStamp: 20,
  sequence: 24,
  reserved: 28,
} as const;

/** Int16 value used for a fully deflected analog axis. */
export const STICK_MAX = 32767;
export const TRIGGER_MAX = 32767;

/**
 * Part 3.7's honest gyro position, encoded where the code has to encode it.
 *
 * The Gamepad API exposes no gyroscope, so in-browser gyro is not viable as core
 * desktop input today. v1 stubs the gyro report as zeros and does not let it gate
 * anything. `gyroValid = 0` is the signal: a title that genuinely requires motion
 * can detect the absence instead of receiving plausible garbage.
 */
export const GYRO_UNAVAILABLE = 0;

export interface HidState {
  buttons: number;
  /** Normalized -1..1. Converted to int16 on publish. */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** Normalized 0..1 analog triggers. */
  zl: number;
  zr: number;
  gyroValid: number;
}

/** The snapshot shape used by the Input Monitor UI. */
export interface HidSnapshot extends HidState {
  pressed: Array<{ bit: keyof typeof HID_BITS; label: string }>;
  sequence: number;
  frameStamp: number;
}

/**
 * Writes a HidState into a shared buffer.
 *
 * Every field write is a plain store; only the `sequence` field uses Atomics, and
 * it is published last. That single release store is the synchronisation point:
 * a reader that observes a new sequence is guaranteed to see the whole struct.
 */
export function publishHidState(sab: SharedArrayBuffer, hid: HidState, frameStamp: number, sequence: number): void {
  const u8 = new Uint8Array(sab);
  const i16 = new Int16Array(sab);
  const u32 = new Uint32Array(sab);
  // Separate views over the same buffer, each aligned: the struct's 4-byte
  // alignment lets a single Int32Array view cover every field, but 16-bit axes
  // need their own aligned view, so we build both once per publish. At 32 bytes
  // this is far cheaper than caching views that could go stale on growth.
  void u8;

  i16[HID_OFFSETS.leftX >> 1] = toAxis(hid.lx);
  i16[HID_OFFSETS.leftY >> 1] = toAxis(hid.ly);
  i16[HID_OFFSETS.rightX >> 1] = toAxis(hid.rx);
  i16[HID_OFFSETS.rightY >> 1] = toAxis(hid.ry);
  i16[HID_OFFSETS.zl >> 1] = toTrigger(hid.zl);
  i16[HID_OFFSETS.zr >> 1] = toTrigger(hid.zr);

  u32[HID_OFFSETS.buttons >> 2] = hid.buttons >>> 0;
  u32[HID_OFFSETS.gyroValid >> 2] = hid.gyroValid;
  u32[HID_OFFSETS.frameStamp >> 2] = frameStamp;

  // Release publication.
  Atomics.store(u32, HID_OFFSETS.sequence >> 2, sequence >>> 0);
}

/** Reads a HidState out of the shared buffer. Used by the Input Monitor. */
export function readHidState(sab: SharedArrayBuffer): HidState {
  const i16 = new Int16Array(sab);
  const u32 = new Uint32Array(sab);

  return {
    buttons: Atomics.load(u32, HID_OFFSETS.buttons >> 2),
    lx: fromAxis(i16[HID_OFFSETS.leftX >> 1] ?? 0),
    ly: fromAxis(i16[HID_OFFSETS.leftY >> 1] ?? 0),
    rx: fromAxis(i16[HID_OFFSETS.rightX >> 1] ?? 0),
    ry: fromAxis(i16[HID_OFFSETS.rightY >> 1] ?? 0),
    zl: fromTrigger(i16[HID_OFFSETS.zl >> 1] ?? 0),
    zr: fromTrigger(i16[HID_OFFSETS.zr >> 1] ?? 0),
    gyroValid: Atomics.load(u32, HID_OFFSETS.gyroValid >> 2),
  };
}

export function readHidSequence(sab: SharedArrayBuffer): number {
  return Atomics.load(new Uint32Array(sab), HID_OFFSETS.sequence >> 2);
}

/** Expands the button bitmask into named entries for the input monitor. */
export function decodeButtons(buttons: number): Array<{ bit: keyof typeof HID_BITS; label: string }> {
  const out: Array<{ bit: keyof typeof HID_BITS; label: string }> = [];
  for (const [name, bit] of Object.entries(HID_BITS) as Array<[keyof typeof HID_BITS, number]>) {
    if (buttons & (1 << bit)) out.push({ bit: name, label: name });
  }
  return out;
}

/** Human-readable name for a KeyboardEvent.code, for the remap editor. */
export function keyCodeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function toAxis(normalized: number): number {
  const clamped = Math.max(-1, Math.min(1, normalized));
  return Math.round(clamped * STICK_MAX);
}

function fromAxis(value: number): number {
  return value / STICK_MAX;
}

function toTrigger(normalized: number): number {
  const clamped = Math.max(0, Math.min(1, normalized));
  return Math.round(clamped * TRIGGER_MAX);
}

function fromTrigger(value: number): number {
  return value / TRIGGER_MAX;
}
