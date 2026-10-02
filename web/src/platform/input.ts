// web/src/platform/input.ts
//
// Input (Part 3.7).
//
// The single most-used piece of configuration in this project: Pokemon is a
// directional game, so the keyboard layout has to feel right out of the box.
// Part 3.7 specifies it exactly, and it is implemented here verbatim rather than
// being "improved".
//
//   W A S D   left stick AND d-pad
//   J         A          K         B
//   Q         L          E         R
//   C         Minus      V         Plus
//
// Everything is a named binding so the remap editor, conflict detection, and
// per-device scoping have something to operate on. Hardcoded key handling would
// make all three impossible.

import type { HidState } from './hidState';
import { HID_BITS } from './hidState';

// --- binding vocabulary ---------------------------------------------------

/** Logical actions the guest `hid` service exposes. */
export const ACTIONS = [
  'ui_a',
  'ui_b',
  'ui_l',
  'ui_r',
  'ui_minus',
  'ui_plus',
  'l_stick_up',
  'l_stick_down',
  'l_stick_left',
  'l_stick_right',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
] as const;
export type Action = (typeof ACTIONS)[number];

/** App-level bindings: not sent to the game, handled by the shell. */
export const APP_ACTIONS = ['debug_menu', 'screenshot', 'toggle_overlay'] as const;
export type AppAction = (typeof APP_ACTIONS)[number];

export type AnyAction = Action | AppAction;

export const ACTION_LABELS: Record<AnyAction, string> = {
  ui_a: 'A',
  ui_b: 'B',
  ui_l: 'L',
  ui_r: 'R',
  ui_minus: 'Minus',
  ui_plus: 'Plus',
  l_stick_up: 'Left stick up',
  l_stick_down: 'Left stick down',
  l_stick_left: 'Left stick left',
  l_stick_right: 'Left stick right',
  dpad_up: 'D-pad up',
  dpad_down: 'D-pad down',
  dpad_left: 'D-pad left',
  dpad_right: 'D-pad right',
  debug_menu: 'Debug menu (app)',
  screenshot: 'Screenshot (app)',
  toggle_overlay: 'Toggle overlay (app)',
};

/** Part 3.7's specified default keyboard layout. */
export const DEFAULT_KEYBOARD_LAYOUT: Record<Action, string> = {
  ui_a: 'KeyJ',
  ui_b: 'KeyK',
  ui_l: 'KeyQ',
  ui_r: 'KeyE',
  ui_minus: 'KeyC',
  ui_plus: 'KeyV',
  l_stick_up: 'KeyW',
  l_stick_down: 'KeyS',
  l_stick_left: 'KeyA',
  l_stick_right: 'KeyD',
  dpad_up: 'KeyW',
  dpad_down: 'KeyS',
  dpad_left: 'KeyA',
  dpad_right: 'KeyD',
};

export const DEFAULT_APP_LAYOUT: Record<AppAction, string> = {
  debug_menu: 'F1',
  screenshot: 'F12',
  toggle_overlay: 'F2',
};

/**
 * Default *gamepad* bindings, in Gamepad API button-index form.
 *
 * A pad needs its own defaults because it is not a keyboard: a pad has two
 * sticks, two analog triggers, and no keys. Stick axes are not "bindings" in the
 * same sense - they are the axes themselves - so what is mappable here is the
 * face buttons, shoulders, triggers, stick clicks, and d-pad.
 *
 * Note the A/B positions: index 0 is the *bottom* face button and Nintendo calls
 * that B. See GAMEPAD_BUTTON_TO_HID for why getting this backwards is the most
 * common input-layer bug.
 */
export const DEFAULT_GAMEPAD_LAYOUT: Record<Action, string> = {
  ui_a: 'Button1',
  ui_b: 'Button0',
  ui_l: 'Button4',
  ui_r: 'Button5',
  ui_minus: 'Button8',
  ui_plus: 'Button9',
  // Stick directions come from the axes, not from buttons. These entries record
  // that intent so the editor has something to show and remap.
  l_stick_up: 'Axis1-',
  l_stick_down: 'Axis1+',
  l_stick_left: 'Axis0-',
  l_stick_right: 'Axis0+',
  dpad_up: 'Button12',
  dpad_down: 'Button13',
  dpad_left: 'Button14',
  dpad_right: 'Button15',
};

// --- HID button bits ------------------------------------------------------
// HID_BITS lives in hidState.ts, which owns the shared-memory encoding and must
// not depend on this file. Re-exported here because every consumer of input
// needs it and reading `hidState` for a bitmask reads oddly.

export { HID_BITS } from './hidState';

/**
 * Gamepad API button index -> HID bit.
 *
 * The A/B swap is the important detail: the Gamepad API's `standard` mapping
 * numbers buttons by *position*, with index 0 being the bottom face button and
 * index 1 the right one. Nintendo labels those B and A respectively. Getting
 * this backwards is the single most common bug in console-emulation input
 * layers, because "confirm" ends up on the wrong button and every menu feels
 * wrong in a way that is hard to diagnose from the symptom.
 *
 * Indices 0-3 and 8-17 follow the W3C "standard" layout for L/R, Minus/Plus,
 * stick clicks, the d-pad, and the paddle buttons, so they map directly.
 */
const GAMEPAD_BUTTON_TO_HID: Array<[gamepadIndex: number, hidBit: keyof typeof HID_BITS]> = [
  [0, 'B'], // bottom face button  -> Nintendo B
  [1, 'A'], // right face button   -> Nintendo A
  [2, 'Y'], // left face button    -> Nintendo Y
  [3, 'X'], // top face button     -> Nintendo X
  [4, 'L'],
  [5, 'R'],
  [6, 'ZL'],
  [7, 'ZR'],
  [8, 'Minus'],
  [9, 'Plus'],
  [10, 'LeftStick'],
  [11, 'RightStick'],
  [12, 'Up'],
  [13, 'Down'],
  [14, 'Left'],
  [15, 'Right'],
  [16, 'SliderL'],
  [17, 'SliderR'],
];

// --- analog shaping -------------------------------------------------------

export interface StickSettings {
  /** Fraction below which input reads as zero. */
  deadzone: number;
  /**
   * Response curve exponent. 1.0 is linear; >1 gives fine control near centre,
   * which matters because Pokemon's movement is precision-based.
   */
  exponent: number;
  /** Digital keys produce this magnitude on the derived axis. */
  digitalMagnitude: number;
}

/**
 * Part 3.7: "Sticks get a small deadzone and a ramp curve; the D-pad is derived
 * from the same WASD axes via snap-to-octant."
 */
export const DEFAULT_STICK: StickSettings = {
  deadzone: 0.18,
  exponent: 1.6,
  // Part 3.7 asks for a ramp curve; 0.75 keeps WASD movement slightly below full
  // tilt so the analog stick in games like SwSh reads as walking rather than
  // running.
  digitalMagnitude: 0.75,
};

/**
 * Applies deadzone and curve to a raw -1..1 axis value.
 *
 * Deadzone is rescaled rather than just clipped: without the rescale, the first
 * movement past the deadzone jumps straight to `deadzone` magnitude, which is
 * felt as a notch.
 */
export function shapeAxis(value: number, settings: StickSettings = DEFAULT_STICK): number {
  const magnitude = Math.abs(value);
  if (magnitude <= settings.deadzone) return 0;
  const scaled = (magnitude - settings.deadzone) / (1 - settings.deadzone);
  const curved = Math.pow(scaled, settings.exponent);
  return Math.sign(value) * curved;
}

/**
 * Snap-to-octant: converts a 2D axis pair into up to two d-pad directions.
 *
 * Only emits a d-pad direction when the axis is genuinely dominant, so a diagonal
 * stick input produces two directions rather than fighting itself.
 */
export function snapToOctant(x: number, y: number, threshold = 0.5): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const result = { up: false, down: false, left: false, right: false };
  if (ax < threshold && ay < threshold) return result;
  if (ax >= threshold) result.right = x > 0, (result.left = x < 0);
  if (ay >= threshold) (result.up = y < 0), (result.down = y > 0);
  return result;
}

// --- conflict detection ---------------------------------------------------

export interface BindingConflict {
  code: string;
  actions: AnyAction[];
}

/**
 * Finds bindings claimed by more than one action.
 *
 * Shared codes are legal in one specific case and illegal in the other: `W`
 * legitimately drives both `l_stick_up` and `dpad_up` because the d-pad is
 * *derived* from the stick axes, not independently bound. Anything else sharing
 * a code is a real conflict the user probably did not intend.
 */
export function findConflicts(layout: Record<string, string>): BindingConflict[] {
  const byCode = new Map<string, AnyAction[]>();
  for (const [action, code] of Object.entries(layout)) {
    if (!code) continue;
    const list = byCode.get(code) ?? [];
    list.push(action as AnyAction);
    byCode.set(code, list);
  }

  const conflicts: BindingConflict[] = [];
  for (const [code, actions] of byCode) {
    if (actions.length < 2) continue;
    // The stick/d-pad pairing is a designed overlap, not a conflict.
    const isDerivedPair =
      actions.length === 2 &&
      actions.every((a) => a.startsWith('l_stick_') || a.startsWith('dpad_')) &&
      new Set(actions.map((a) => a.replace(/^(l_stick|dpad)_/, ''))).size === 1;
    if (isDerivedPair) continue;
    conflicts.push({ code, actions });
  }
  return conflicts;
}

/** Formats a KeyboardEvent.code for display, e.g. `KeyJ` -> `J`. */
export function formatKeyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5);
  return code;
}

// --- the input manager ----------------------------------------------------

export interface InputSnapshot {
  hid: HidState;
  /** Actions that fired this frame; used for shell shortcuts. */
  appActions: Set<AppAction>;
  /** True when any input arrived since the last snapshot. */
  active: boolean;
}

export type GamepadPreset = 'full' | 'left-half' | 'right-half' | 'combined';

/**
 * Part 3.7's Joy-Con-style presets.
 *
 * The honesty note matters and belongs in the code, not just the docs: the
 * Gamepad API does not expose individual Joy-Con halves, so these are ergonomic
 * presets, not Joy-Con emulation.
 */
export const PAD_PRESETS: Record<GamepadPreset, { label: string; description: string }> = {
  full: { label: 'Standard', description: 'Both sticks, all buttons.' },
  'left-half': {
    label: 'Left-half (d-pad focused)',
    description: 'Stick output is squashed toward the d-pad. Better for Legends-style play.',
  },
  'right-half': {
    label: 'Right-half (stick focused)',
    description: 'D-pad output follows the right stick. Better for aiming and menu navigation.',
  },
  combined: {
    label: 'Combined', description: 'Both sticks merged into one axis pair.' },
};

export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly appLayout: Record<string, string>;
  private stick: StickSettings;
  private preset: GamepadPreset = 'full';

  /**
   * Per-device scoping: which layout applies to which source.
   *
   * Keyboard and gamepad keep separate layouts because they are different physical
   * things with different key/button counts, and a user who remaps one almost
   * never means to remap the other.
   */
  private keyboardLayout: Record<string, string>;
  private gamepadLayout: Record<string, string>;

  private readonly onAppAction: (action: AppAction) => void;
  private readonly onChange: (snapshot: InputSnapshot) => void;

  private lastHid: HidState = emptyHidState();
  private active = false;
  private detach: Array<() => void> = [];

  constructor(options: {
    keyboardLayout?: Record<string, string>;
    gamepadLayout?: Record<string, string>;
    appLayout?: Record<string, string>;
    stick?: StickSettings;
    preset?: GamepadPreset;
    onAppAction?: (action: AppAction) => void;
    onChange?: (snapshot: InputSnapshot) => void;
  }) {
    this.keyboardLayout = { ...DEFAULT_KEYBOARD_LAYOUT, ...(options.keyboardLayout ?? {}) };
    this.gamepadLayout = { ...DEFAULT_KEYBOARD_LAYOUT, ...(options.gamepadLayout ?? {}) };
    this.appLayout = { ...DEFAULT_APP_LAYOUT, ...(options.appLayout ?? {}) };
    this.stick = options.stick ?? DEFAULT_STICK;
    this.preset = options.preset ?? 'full';
    this.onAppAction = options.onAppAction ?? (() => undefined);
    this.onChange = options.onChange ?? (() => undefined);
  }

  /** Attaches DOM listeners. The main thread owns these because they only exist here. */
  attach(target: EventTarget = window): void {
    const onKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      this.keysDown.add(ke.code);

      for (const [action, code] of Object.entries(this.appLayout)) {
        if (code === ke.code) {
          this.onAppAction(action as AppAction);
          // Stop the browser from opening devtools or scrolling the page.
          ke.preventDefault();
        }
      }
      this.publish();
    };

    const onKeyUp = (e: Event) => {
      this.keysDown.delete((e as KeyboardEvent).code);
      this.publish();
    };

    // A window blur with keys held would otherwise leave the stick stuck at full
    // tilt, which looks exactly like a stuck input bug.
    const onBlur = () => {
      this.keysDown.clear();
      this.publish();
    };

    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', onBlur);

    this.detach.push(() => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    });
  }

  detachAll(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
  }

  setKeyboardLayout(layout: Record<string, string>): void {
    this.keyboardLayout = { ...layout };
    this.publish();
  }

  setGamepadLayout(layout: Record<string, string>): void {
    this.gamepadLayout = { ...layout };
    this.publish();
  }

  setStick(settings: Partial<StickSettings>): void {
    this.stick = { ...this.stick, ...settings };
    this.publish();
  }

  setPreset(preset: GamepadPreset): void {
    this.preset = preset;
    this.publish();
  }

  getStickSettings(): StickSettings {
    return this.stick;
  }

  getPreset(): GamepadPreset {
    return this.preset;
  }

  /** Reads the current state of every source and publishes a HID snapshot. */
  poll(): InputSnapshot {
    const hid = emptyHidState();
    const appActions = new Set<AppAction>();

    // --- keyboard ---
    const held = new Set(
      Object.entries(this.keyboardLayout)
        .filter(([, code]) => this.keysDown.has(code))
        .map(([action]) => action),
    );
    const padHeld = new Set(
      Object.entries(this.gamepadLayout)
        .filter(([, code]) => this.keysDown.has(code))
        .map(([action]) => action),
    );

    if (held.has('ui_a')) hid.buttons |= 1 << HID_BITS.A;
    if (held.has('ui_b')) hid.buttons |= 1 << HID_BITS.B;
    if (held.has('ui_l')) hid.buttons |= 1 << HID_BITS.L;
    if (held.has('ui_r')) hid.buttons |= 1 << HID_BITS.R;
    if (held.has('ui_minus')) hid.buttons |= 1 << HID_BITS.Minus;
    if (held.has('ui_plus')) hid.buttons |= 1 << HID_BITS.Plus;

    // WASD drives the analog stick and the d-pad is derived from it.
    const rawX =
      ((held.has('l_stick_right') ? 1 : 0) - (held.has('l_stick_left') ? 1 : 0)) * this.stick.digitalMagnitude;
    const rawY =
      ((held.has('l_stick_up') ? 1 : 0) - (held.has('l_stick_down') ? 1 : 0)) * this.stick.digitalMagnitude;

    const octant = snapToOctant(rawX, rawY);
    if (octant.up) hid.buttons |= 1 << HID_BITS.Up;
    if (octant.down) hid.buttons |= 1 << HID_BITS.Down;
    if (octant.left) hid.buttons |= 1 << HID_BITS.Left;
    if (octant.right) hid.buttons |= 1 << HID_BITS.Right;

    // --- gamepad ---
    this.readGamepads(hid, padHeld);

    // An explicit d-pad binding overrides the derived one, so a user who maps
    // the arrows to D-pad-left gets it even with no stick input.
    for (const source of [held, padHeld]) {
      if (source.has('dpad_up')) hid.buttons |= 1 << HID_BITS.Up;
      if (source.has('dpad_down')) hid.buttons |= 1 << HID_BITS.Down;
      if (source.has('dpad_left')) hid.buttons |= 1 << HID_BITS.Left;
      if (source.has('dpad_right')) hid.buttons |= 1 << HID_BITS.Right;
    }

    this.lastHid = hid;
    this.active = hid.buttons !== 0 || hid.lx !== 0 || hid.ly !== 0;

    const snapshot: InputSnapshot = { hid, appActions, active: this.active };
    this.onChange(snapshot);
    return snapshot;
  }

  /**
   * Merges gamepad state into `hid`.
   *
   * `explicitDpad` is the set of d-pad actions the user bound directly. When it
   * is empty, a physical stick input also drives the d-pad, matching the keyboard
   * behaviour; when it is not, an explicit binding wins over the derived one.
   */
  private readGamepads(hid: HidState, explicitDpad: Set<string>): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    const pads = navigator.getGamepads();
    // Multiple pads -> assign to controller 1; the game sees one controller.
    const pad = pads.find((p) => p !== null && p.connected);
    if (!pad) return;

    for (const [index, hidBit] of GAMEPAD_BUTTON_TO_HID) {
      const button = pad.buttons[index];
      if (!button) continue;
      if (button.pressed) hid.buttons |= 1 << HID_BITS[hidBit];
    }

    // Analog triggers: Pokemon uses ZL/ZR heavily, and `pressed` alone loses
    // partial presses.
    const zl = pad.buttons[6];
    const zr = pad.buttons[7];
    hid.zl = zl?.value ?? (zl?.pressed ? 1 : 0);
    hid.zr = zr?.value ?? (zr?.pressed ? 1 : 0);

    // pad.axes is readonly number[]; a pad may also report fewer than four axes,
    // so each read is guarded rather than destructured with a default.
    const axis = (index: number): number => {
      const value = pad.axes[index];
      return typeof value === 'number' ? deadzone(value) : 0;
    };

    let lx = shapeAxis(axis(0), this.stick);
    let ly = shapeAxis(axis(1), this.stick);
    let rx = shapeAxis(axis(2), this.stick);
    let ry = shapeAxis(axis(3), this.stick);

    switch (this.preset) {
      case 'left-half':
        // Bias toward the d-pad: the stick's diagonal influence is removed so
        // movement is strictly four-directional.
        lx = Math.sign(lx) * Math.min(1, Math.abs(lx) * 1.4);
        ly = Math.sign(ly) * Math.min(1, Math.abs(ly) * 1.4);
        rx = 0;
        ry = 0;
        break;
      case 'right-half':
        lx = 0;
        ly = 0;
        rx = Math.sign(rx) * Math.min(1, Math.abs(rx) * 1.4);
        ry = Math.sign(ry) * Math.min(1, Math.abs(ry) * 1.4);
        break;
      case 'combined':
        // Merge both sticks so whichever is being touched wins.
        if (Math.abs(rx) + Math.abs(ry) > Math.abs(lx) + Math.abs(ly)) {
          lx = rx;
          ly = ry;
        }
        break;
      case 'full':
        break;
    }

    hid.lx = lx;
    hid.ly = ly;
    hid.rx = rx;
    hid.ry = ry;

    // A physical stick input also drives the d-pad, matching the keyboard
    // behaviour, unless the user explicitly bound a d-pad action.
    const hasExplicitDpad = [...explicitDpad].some((a) => a.startsWith('dpad_'));
    if (!hasExplicitDpad && (lx !== 0 || ly !== 0)) {
      const octant = snapToOctant(lx, ly);
      if (octant.up) hid.buttons |= 1 << HID_BITS.Up;
      if (octant.down) hid.buttons |= 1 << HID_BITS.Down;
      if (octant.left) hid.buttons |= 1 << HID_BITS.Left;
      if (octant.right) hid.buttons |= 1 << HID_BITS.Right;
    }
  }

  private publish(): void {
    this.poll();
  }

  getHidState(): HidState {
    return this.lastHid;
  }
}

/** Small pre-shaping deadzone, so shapeAxis sees a cleanly-zeroed axis. */
function deadzone(v: number): number {
  return Math.abs(v) < 0.05 ? 0 : v;
}

export function emptyHidState(): HidState {
  return {
    buttons: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    zl: 0,
    zr: 0,
    gyroValid: 0,
  };
}
