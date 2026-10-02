// web/src/ui/Audio/AudioScreen.tsx
//
// Part 3.10's audio settings.
//
// The buffer-size control is the interesting one, because Part 3.6 frames it as a
// genuine latency/robustness trade rather than a quality setting: a larger ring
// rides out a JIT pause or a page-cache miss, a smaller one feels tighter. The UI
// states the millisecond figure so the choice is informed.
//
// The live readouts come from the AudioWorklet, not from the worker. That
// distinction is the whole point of the two-stage design: only the worklet knows
// whether the *device* was actually fed, and an underrun there is the only failure
// a user can hear.

import { Card, Pill } from '../components';
import type { AudioSettings } from '../../state/appState';
import {
  GUEST_SAMPLE_RATE,
  RING_TOTAL_FRAMES,
  EMPTY_AUDIO_STATUS,
  type AudioStatus,
} from '../../platform/audio';

interface AudioScreenProps {
  settings: AudioSettings;
  onChange: (patch: Partial<AudioSettings>) => void;
  status: AudioStatus;
  latestLog: string | null;
  onEnable: () => void;
}

const BUFFER_CHOICES = [512, 1024, 2048, 4096];

/** Ring depth for a given chunk size: 8 buffers, per Part 3.6. */
const RING_BUFFERS = 8;

export function AudioScreen({ settings, onChange, status, latestLog, onEnable }: AudioScreenProps) {
  const enabled = status.state === 'running' || status.state === 'suspended';
  const unavailable = status.state === 'unavailable';

  const ringFrames = settings.bufferFrames * RING_BUFFERS;
  const ringMs = (ringFrames / GUEST_SAMPLE_RATE) * 1000;
  const chunkMs = (settings.bufferFrames / GUEST_SAMPLE_RATE) * 1000;

  const fillPercent = enabled ? (status.fillFrames / status.ringCapacityFrames) * 100 : 0;
  const underrunRate =
    status.elapsedSeconds > 0 ? status.underruns / status.elapsedSeconds : 0;

  return (
    <>
      <h2>Audio</h2>
      <p className="lede">
        The Switch&apos;s audio renderer is emulated at {GUEST_SAMPLE_RATE / 1000} kHz on the audio
        worker. The AudioWorklet, which owns the device connection, only resamples and outputs, so a
        hiccup in the emulator cannot glitch the sound.
      </p>

      <Card
        title="Output"
        badge={
          status.state === 'running' ? (
            <Pill tone="ok">running</Pill>
          ) : status.state === 'suspended' ? (
            <Pill tone="warn">suspended</Pill>
          ) : unavailable ? (
            <Pill tone="err">unavailable</Pill>
          ) : (
            <Pill tone="muted">not started</Pill>
          )
        }
      >
        {unavailable ? (
          <div className="callout callout-err">
            <div className="callout-title">AudioWorklet is unavailable</div>
            <div className="callout-body">
              <p>
                Audio output is disabled. The audio worker may still be producing into the ring, but
                nothing can consume it.
              </p>
            </div>
          </div>
        ) : !enabled ? (
          <>
            <p className="muted">
              Audio has not started. Browsers require a user gesture before audio may play; click
              anywhere or press a key to start it.
            </p>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={onEnable}>
                Start audio
              </button>
            </div>
          </>
        ) : (
          <>
            <table>
              <tbody>
                <tr>
                  <td className="muted">Device sample rate</td>
                  <td className="num">{status.sampleRate ? `${status.sampleRate} Hz` : '—'}</td>
                </tr>
                <tr>
                  <td className="muted">Guest (audren) rate</td>
                  <td className="num">{GUEST_SAMPLE_RATE} Hz</td>
                </tr>
                <tr>
                  <td className="muted">Resampling</td>
                  <td className="num">
                    {status.resampling
                      ? `yes, in the worklet (${status.sampleRate} → ${GUEST_SAMPLE_RATE})`
                      : 'not needed'}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Frames played</td>
                  <td className="num">
                    {status.framesPlayed.toLocaleString()}
                    {status.elapsedSeconds > 0 && (
                      <span className="muted">
                        {' '}
                        over {status.elapsedSeconds.toFixed(0)}s (
                        {(status.framesPlayed / status.elapsedSeconds).toFixed(0)}/s)
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Ring fill</td>
                  <td className="num">
                    {status.fillFrames.toLocaleString()} / {status.ringCapacityFrames.toLocaleString()}{' '}
                    frames ({fillPercent.toFixed(0)}%)
                  </td>
                </tr>
                <tr>
                  <td className="muted">Underruns</td>
                  <td className="num">
                    {status.underruns}
                    {status.elapsedSeconds > 0 && (
                      <span className="muted"> ({underrunRate.toFixed(2)}/s)</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            {status.underruns > 0 ? (
              <div className="callout callout-warn" style={{ marginTop: 12 }}>
                <div className="callout-title">Underruns detected</div>
                <div className="callout-body">
                  <p>
                    The worklet asked for audio the producer had not delivered. That is audible as a
                    crackle or a dropout. Increasing the buffer size gives the producer more slack.
                  </p>
                </div>
              </div>
            ) : status.state === 'running' ? (
              <div className="callout callout-ok" style={{ marginTop: 12 }}>
                <div className="callout-title">No underruns</div>
                <div className="callout-body">
                  <p>
                    {status.framesPlayed.toLocaleString()} frames delivered with nothing missed. Part 6
                    Phase 3 gates on a 30-minute session with a zero underrun count.
                  </p>
                </div>
              </div>
            ) : (
              <div className="callout callout-info" style={{ marginTop: 12 }}>
                <div className="callout-title">Waiting for a user gesture</div>
                <div className="callout-body">
                  <p>
                    The context exists but is suspended, which is the browser&apos;s autoplay policy
                    rather than a fault. It resumes on the next click or key press.
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        {latestLog && <pre style={{ marginTop: 12 }}>{latestLog}</pre>}
      </Card>

      <Card title="Buffering">
        <label className="field">
          <span className="label-text">Chunk size</span>
          <select
            value={settings.bufferFrames}
            onChange={(e) => onChange({ bufferFrames: Number(e.target.value) })}
          >
            {BUFFER_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} frames ({((n / GUEST_SAMPLE_RATE) * 1000).toFixed(1)} ms)
              </option>
            ))}
          </select>
          <span className="field-hint">
            Each queued buffer holds this many frames. The full ring is {RING_BUFFERS} buffers,
            about {ringMs.toFixed(0)} ms of slack, which is what rides out a JIT compile or a
            page-cache miss without an audible dropout.
          </span>
        </label>

        <table>
          <tbody>
            <tr>
              <td className="muted">Per-buffer latency</td>
              <td className="num">{chunkMs.toFixed(1)} ms</td>
            </tr>
            <tr>
              <td className="muted">Ring depth ({RING_BUFFERS} buffers)</td>
              <td className="num">
                {ringFrames.toLocaleString()} frames / {ringMs.toFixed(0)} ms
              </td>
            </tr>
            <tr>
              <td className="muted">Currently allocated</td>
              <td className="num">
                {RING_TOTAL_FRAMES.toLocaleString()} frames (
                {((RING_TOTAL_FRAMES / GUEST_SAMPLE_RATE) * 1000).toFixed(0)} ms)
              </td>
            </tr>
          </tbody>
        </table>

        <div className="callout callout-info" style={{ marginTop: 12 }}>
          <div className="callout-title">When to change this</div>
          <div className="callout-body">
            <p>
              If audio crackles during heavy scenes, increase it: that means underruns, and a deeper
              ring tolerates longer stalls. If input feels disconnected from the sound, decrease it.
            </p>
            <p className="muted">
              The ring itself is allocated at a fixed size today. Changing this setting changes the
              producer&apos;s target depth; reallocating the ring is Phase 2 work.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Latency hint">
        <label className="field">
          <span className="label-text">AudioContext latencyHint</span>
          <select
            value={settings.latencyHint}
            onChange={(e) => onChange({ latencyHint: e.target.value as AudioSettings['latencyHint'] })}
          >
            <option value="interactive">interactive (lowest latency)</option>
            <option value="balanced">balanced</option>
            <option value="playback">playback (smoothest, highest latency)</option>
          </select>
          <span className="field-hint">
            Applies when the audio graph is created, so it takes effect on the next session. The
            browser may ignore it. It affects only the OS audio buffer, not the emulated renderer.
          </span>
        </label>
      </Card>

      <Card title="Volume">
        <div className="checkbox-row">
          <input
            id="mute"
            type="checkbox"
            checked={settings.muted}
            onChange={(e) => onChange({ muted: e.target.checked })}
          />
          <label htmlFor="mute">Mute all audio</label>
        </div>

        <label className="field">
          <span className="label-text">Application volume</span>
          <div className="range-row">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(e) => onChange({ volume: Number(e.target.value) })}
              disabled={settings.muted}
            />
            <span className="range-value">{Math.round(settings.volume * 100)}%</span>
          </div>
        </label>
      </Card>

      <Card title="Thread topology" badge={<Pill tone="muted">as implemented</Pill>}>
        <p>
          One deviation from Part 3.6&apos;s diagram, forced by the platform:{' '}
          <code>AudioContext</code> is not exposed in a dedicated worker, so the AudioWorklet cannot
          be created inside the audio worker. The split is therefore:
        </p>
        <div className="path-tree">
          <div>audio worker &nbsp;&rarr; audren renderer, writes 48 kHz frames</div>
          <div>SharedArrayBuffer &nbsp;&rarr; SPSC ring, {RING_TOTAL_FRAMES.toLocaleString()} frames</div>
          <div>main thread &nbsp;&rarr; AudioContext + AudioWorkletNode, device</div>
          <div className="muted">
            &nbsp;&nbsp;&nbsp;&nbsp;worklet: read, resample, output, count underruns
          </div>
        </div>
        <p className="field-hint" style={{ marginTop: 10 }}>
          The property Part 3.6 actually depends on still holds: the DSP is not on the OS render
          thread, so a pause in the emulator cannot glitch the output.
        </p>
      </Card>

      <Card title="Not yet implemented" badge={<Pill tone="muted">Phase 3</Pill>}>
        <p>
          The current renderer emits a 440 Hz placeholder. That proves the ring, the worklet, the
          sample-rate negotiation, and the underrun accounting all work end to end. The audren DSP
          graph — voices, biquads, delays, volume ramps, output buses — replaces it in Phase 3 behind
          the same <code>write()</code> call, with no structural change.
        </p>
      </Card>
    </>
  );
}

export { EMPTY_AUDIO_STATUS };
