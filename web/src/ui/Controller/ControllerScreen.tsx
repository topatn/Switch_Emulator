// web/src/ui/Controller/ControllerScreen.tsx
//
// Part 3.10's controller config screen: "the remap editor with Joy-Con-style
// presets, deadzone/curve sliders, and a live input monitor showing what the game
// sees - invaluable for debugging."
//
// The input monitor is the part that earns its keep. When a title misbehaves, the
// first question is always "what does the game think the controller is doing",
// and answering that requires seeing the *post-shaping* values, not the raw key
// events. So the monitor reads the same shared-memory struct the CPU worker
// reads, not a separate copy of the input state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Pill } from '../components';
import {
  ACTIONS,
  ACTION_LABELS,
  APP_ACTIONS,
  DEFAULT_KEYBOARD_LAYOUT,
  DEFAULT_GAMEPAD_LAYOUT,
  DEFAULT_APP_LAYOUT,
  DEFAULT_STICK,
  PAD_PRESETS,
  findConflicts,
  formatKeyCode,
  type Action,
  type AnyAction,
  type AppAction,
  type GamepadPreset,
  type StickSettings,
} from '../../platform/input';
import { HID_STATE_BYTES, decodeButtons, readHidSequence, readHidState, type HidState } from '../../platform/hidState';

interface ControllerScreenProps {
  keyboardLayout: Record<string, string>;
  /**
   * Gamepad bindings, shown alongside the keyboard ones. A pad has different
   * physical inputs from a keyboard, so hiding this behind a toggle would make
   * the remap editor harder to use than it needs to be.
   */
  gamepadLayout: Record<string, string>;
  appLayout: Record<string, string>;
  stick: StickSettings;
  preset: GamepadPreset;
  onKeyboardLayout: (layout: Record<string, string>) => void;
  onGamepadLayout: (layout: Record<string, string>) => void;
  onAppLayout: (layout: Record<string, string>) => void;
  onStick: (settings: StickSettings) => void;
  onPreset: (preset: GamepadPreset) => void;
  /** The live HID shared buffer, owned by the app shell. */
  hidSab: SharedArrayBuffer | null;
}

export function ControllerScreen({
  keyboardLayout,
  gamepadLayout,
  appLayout,
  stick,
  preset,
  onKeyboardLayout,
  onGamepadLayout,
  onAppLayout,
  onStick,
  onPreset,
  hidSab,
}: ControllerScreenProps) {
  const [capturing, setCapturing] = useState<AnyAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const conflicts = useMemo(
    () => findConflicts({ ...keyboardLayout, ...appLayout }),
    [keyboardLayout, appLayout],
  );
  const conflictedCodes = useMemo(() => new Set(conflicts.map((c) => c.code)), [conflicts]);

  // Capture mode: the next keydown becomes the binding, Escape cancels.
  useEffect(() => {
    if (capturing === null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === 'Escape') {
        setCapturing(null);
        return;
      }

      const isApp = (APP_ACTIONS as readonly string[]).includes(capturing);
      const map = { ...(isApp ? appLayout : keyboardLayout) };
      // Remove this code from any other action so a re-bind does not silently
      // create a conflict.
      for (const key of Object.keys(map)) {
        if (map[key] === e.code && key !== capturing) delete map[key];
      }
      map[capturing] = e.code;

      if (isApp) onAppLayout(map as Record<AppAction, string>);
      else onKeyboardLayout(map as Record<Action, string>);
      setCapturing(null);
    };

    // Capture phase so the app's own shortcuts (F1/F2/F12) do not fire first.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [capturing, keyboardLayout, appLayout, onKeyboardLayout, onAppLayout]);

  /**
   * Records a gamepad button as a binding.
   *
   * Gamepad buttons are captured through a poll rather than an event, because the
   * Gamepad API has no button events at all - `buttons` is only readable from
   * `getGamepads()`. Polling is the only option, and the cost is one array read
   * per frame while the user is mid-assignment.
   */
  const captureGamepadButton = useCallback(
    (action: Action) => {
      const pads = navigator.getGamepads?.();
      const pad = pads?.find((p) => p !== null && p.connected);
      if (!pad) {
        setNotice('No gamepad is connected. Connect one and press the button you want to bind.');
        return;
      }
      for (const [index, button] of pad.buttons.entries()) {
        if (button.pressed) {
          const map = { ...gamepadLayout };
          for (const key of Object.keys(map)) {
            if (map[key] === `Button${index}` && key !== action) delete map[key];
          }
          map[action] = `Button${index}`;
          onGamepadLayout(map as Record<Action, string>);
          setNotice(`${ACTION_LABELS[action]} bound to gamepad button ${index}.`);
          return;
        }
      }
      setNotice('No gamepad button is currently pressed.');
    },
    [gamepadLayout, onGamepadLayout],
  );

  return (
    <>
      <h2>Controller</h2>
      <p className="lede">
        Every action is a named binding, so the layout below can be remapped per device. The monitor
        on the right shows the exact values the guest <code>hid</code> service will see.
      </p>

      <div className="grid-2">
        <div>
          <Card
            title="Bindings"
            badge={
              conflicts.length > 0 ? (
                <Pill tone="warn">{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}</Pill>
              ) : (
                <Pill tone="ok">no conflicts</Pill>
              )
            }
          >
            {conflicts.length > 0 && (
              <div className="callout callout-warn">
                <div className="callout-title">Conflicting bindings</div>
                <div className="callout-body">
                  {conflicts.map((c) => (
                    <div key={c.code}>
                      <strong>{formatKeyCode(c.code)}</strong> is bound to{' '}
                      {c.actions.map((a) => ACTION_LABELS[a] ?? a).join(' and ')}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <table className="remap-grid">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Keyboard</th>
                  <th>Gamepad</th>
                </tr>
              </thead>
              <tbody>
                {ACTIONS.map((action) => {
                  const keyCode = keyboardLayout[action] ?? '';
                  const padCode = gamepadLayout[action] ?? '';
                  const isCapturing = capturing === action;
                  return (
                    <tr key={action} className={isCapturing ? 'remap-row-capturing' : undefined}>
                      <td>{ACTION_LABELS[action]}</td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => setCapturing(isCapturing ? null : action)}
                          aria-label={`Rebind ${ACTION_LABELS[action]} on the keyboard`}
                        >
                          {isCapturing ? (
                            <span className="binding-chip">
                              <span className="spinner" style={{ width: 9, height: 9 }} /> press a key
                            </span>
                          ) : (
                            <span className={`binding-chip${conflictedCodes.has(keyCode) ? ' conflict' : ''}`}>
                              {keyCode ? formatKeyCode(keyCode) : 'unbound'}
                            </span>
                          )}
                        </button>
                      </td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => captureGamepadButton(action)}
                          aria-label={`Bind ${ACTION_LABELS[action]} to a gamepad button`}
                        >
                          <span className="binding-chip">
                            {padCode ? formatKeyCode(padCode) : 'click to assign'}
                          </span>
                        </button>
                      </td>
                    </tr>
                  );
                })}

                <tr>
                  <td colSpan={3} style={{ paddingTop: 16, borderBottom: 'none' }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Application shortcuts (not sent to the guest)
                    </span>
                  </td>
                </tr>

                {APP_ACTIONS.map((action) => {
                  const code = appLayout[action] ?? '';
                  const isCapturing = capturing === action;
                  return (
                    <tr key={action} className={isCapturing ? 'remap-row-capturing' : undefined}>
                      <td>{ACTION_LABELS[action]}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => setCapturing(isCapturing ? null : action)}>
                          {isCapturing ? (
                            <span className="binding-chip">
                              <span className="spinner" style={{ width: 9, height: 9 }} /> press a key
                            </span>
                          ) : (
                            <span className={`binding-chip${conflictedCodes.has(code) ? ' conflict' : ''}`}>
                              {code ? formatKeyCode(code) : 'unbound'}
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="muted">—</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {notice && (
              <div className="callout callout-info" style={{ marginTop: 12 }}>
                <div className="callout-body">{notice}</div>
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 16 }}>
              <button
                className="btn"
                onClick={() => {
                  onKeyboardLayout({ ...DEFAULT_KEYBOARD_LAYOUT });
                  onGamepadLayout({ ...DEFAULT_GAMEPAD_LAYOUT });
                  onAppLayout({ ...DEFAULT_APP_LAYOUT });
                  onStick({ ...DEFAULT_STICK });
                  setNotice('Bindings and stick settings reset to defaults.');
                }}
              >
                Reset to defaults
              </button>
            </div>
          </Card>

          <Card title="Sticks">
            <label className="field">
              <span className="label-text">Deadzone: {stick.deadzone.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={stick.deadzone}
                onChange={(e) => onStick({ ...stick, deadzone: Number(e.target.value) })}
              />
              <span className="field-hint">
                Input below this magnitude reads as zero. A small value keeps slow walking possible;
                too small lets the stick drift.
              </span>
            </label>

            <label className="field">
              <span className="label-text">Response curve: {stick.exponent.toFixed(2)}</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={stick.exponent}
                onChange={(e) => onStick({ ...stick, exponent: Number(e.target.value) })}
              />
              <span className="field-hint">
                1.0 is linear. Higher values give finer control near centre, which matters in a game
                built on precision movement.
              </span>
            </label>

            <label className="field">
              <span className="label-text">Digital key magnitude: {stick.digitalMagnitude.toFixed(2)}</span>
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={stick.digitalMagnitude}
                onChange={(e) => onStick({ ...stick, digitalMagnitude: Number(e.target.value) })}
              />
              <span className="field-hint">
                How far WASD pushes the analog axis. Below 1.0 so keyboard movement reads as walking
                rather than running.
              </span>
            </label>
          </Card>

          <Card title="Gamepad">
            <label className="field">
              <span className="label-text">Preset</span>
              <select value={preset} onChange={(e) => onPreset(e.target.value as GamepadPreset)}>
                {(Object.keys(PAD_PRESETS) as GamepadPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {PAD_PRESETS[key].label}
                  </option>
                ))}
              </select>
              <span className="field-hint">{PAD_PRESETS[preset].description}</span>
            </label>

            <div className="callout callout-info">
              <div className="callout-title">These are ergonomic presets, not Joy-Con emulation</div>
              <div className="callout-body">
                <p>
                  The Gamepad API does not expose individual Joy-Con halves, so true Joy-Con support is
                  out of scope. What ships here is a preset that shapes a full controller so that
                  d-pad-focused or stick-focused play feels right.
                </p>
                <p>
                  Analog triggers are read from <code>buttons[i].value</code>, not just
                  <code>pressed</code>, because titles use ZL/ZR partially.
                </p>
              </div>
            </div>

            <div className="callout callout-warn">
              <div className="callout-title">No gyroscope</div>
              <div className="callout-body">
                <p>
                  The Gamepad API exposes no gyroscope. In-browser gyro would require
                  DeviceOrientation (mobile) or an external WebHID/WebSerial bridge, so this build
                  reports zeros and nothing is gated on it.
                </p>
              </div>
            </div>
          </Card>
        </div>

        <div>
          <InputMonitor hidSab={hidSab} />
          <Card title="Default layout">
            <p className="field-hint">
              The out-of-the-box mapping is WASD for both the left stick and the d-pad, because Pokemon
              is a directional game and this is the mapping most users will keep.
            </p>
            <table>
              <tbody>
                {ACTIONS.slice(0, 6).map((action) => (
                  <tr key={action}>
                    <td>{ACTION_LABELS[action]}</td>
                    <td className="num">{formatKeyCode(DEFAULT_KEYBOARD_LAYOUT[action])}</td>
                  </tr>
                ))}
                <tr>
                  <td>Left stick + D-pad</td>
                  <td className="num">W A S D</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Live view of the HID state the guest will read.
 *
 * Polls shared memory on an interval rather than subscribing to input events,
 * because the value of this monitor is showing the *published* state: if a
 * publish is being dropped or a field is being written after the release store,
 * only a reader of the shared buffer will show it.
 */
function InputMonitor({ hidSab }: { hidSab: SharedArrayBuffer | null }) {
  const [hid, setHid] = useState<HidState | null>(null);
  const [sequence, setSequence] = useState(0);
  const rafRef = useRef(0);

  const read = useCallback(() => {
    if (!hidSab) {
      setHid(null);
      return;
    }
    setHid(readHidState(hidSab));
    setSequence(readHidSequence(hidSab));
  }, [hidSab]);

  useEffect(() => {
    if (!hidSab) return;
    read();
    // 20 Hz is enough to read comfortably and costs nothing.
    const timer = window.setInterval(read, 50);
    rafRef.current = window.setTimeout(() => undefined);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(rafRef.current);
    };
  }, [hidSab, read]);

  const pressed = hid ? decodeButtons(hid.buttons) : [];

  return (
    <Card
      title="Input monitor"
      badge={<Pill tone={hidSab ? 'ok' : 'muted'}>{hidSab ? `${HID_STATE_BYTES} B shared` : 'not attached'}</Pill>}
    >
      {!hidSab ? (
        <p className="muted">
          No HID shared buffer is attached. It is created when a session starts.
        </p>
      ) : (
        <>
          <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
            <AxisVisualizer label="Left" x={hid!.lx} y={hid!.ly} />
            <AxisVisualizer label="Right" x={hid!.rx} y={hid!.ry} deadzone={DEFAULT_STICK.deadzone} />
          </div>

          <h3>Buttons</h3>
          <div className="row" style={{ gap: 5, minHeight: 24 }}>
            {pressed.length === 0 ? (
              <span className="muted">none pressed</span>
            ) : (
              pressed.map((b) => <Pill key={b.bit} tone="accent">{b.label}</Pill>)
            )}
          </div>

          <h3>Triggers</h3>
          <div className="row">
            <span className="mono">ZL {hid!.zl.toFixed(3)}</span>
            <span className="mono">ZR {hid!.zr.toFixed(3)}</span>
          </div>

          <h3>Raw</h3>
          <table>
            <tbody>
              <tr>
                <td className="muted">buttons</td>
                <td className="num">0x{hid!.buttons.toString(16).padStart(8, '0')}</td>
              </tr>
              <tr>
                <td className="muted">sequence</td>
                <td className="num">{sequence}</td>
              </tr>
              <tr>
                <td className="muted">gyroValid</td>
                <td className="num">{hid!.gyroValid} (0 = no gyro; the API has none)</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function AxisVisualizer({
  label,
  x,
  y,
  deadzone = DEFAULT_STICK.deadzone,
}: {
  label: string;
  x: number;
  y: number;
  deadzone?: number;
}) {
  // Screen y is inverted relative to stick y.
  const left = `${50 + x * 45}%`;
  const top = `${50 - y * 45}%`;
  const deadzonePct = deadzone * 45;

  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 5 }}>
        {label} stick
      </div>
      <div className="axis-visualizer">
        <div
          className="axis-deadzone"
          style={{ width: `${deadzonePct * 2}%`, height: `${deadzonePct * 2}%` }}
        />
        <div className="axis-dot" style={{ left, top }} />
        <span className="axis-label" style={{ top: 2, left: '50%', transform: 'translateX(-50%)' }}>
          up
        </span>
        <span className="axis-label" style={{ bottom: 2, left: '50%', transform: 'translateX(-50%)' }}>
          down
        </span>
      </div>
      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>
        x {x.toFixed(3)}  y {y.toFixed(3)}
      </div>
    </div>
  );
}
