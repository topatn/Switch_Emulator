// web/src/ui/Graphics/GraphicsScreen.tsx
//
// Part 3.10's graphics settings: "host resolution scale (0.25-1.0), vsync mode,
// FPS cap, frame-pacing mode, shader-cache management (clear/rebuild), plus live
// readouts".
//
// The one piece of real guidance here is the DRS interaction. Part 3.11 says host
// resolution scale "composes multiplicatively with guest DRS" and that users need
// to understand it, because a Sword/Shield session at guest DRS 0.8 and host scale
// 0.66 is rendering at 53% of native and nobody knows why it looks soft. Saying
// that plainly is worth more than another slider.

import { Card, Pill } from '../components';
import type { GraphicsSettings, FramePacingMode, VsyncMode } from '../../state/appState';

interface GraphicsScreenProps {
  settings: GraphicsSettings;
  adapter: {
    vendor?: string;
    architecture?: string;
    description?: string;
    isFallback?: boolean;
    maxBufferSize?: number;
    maxTextureDimension2D?: number;
  } | null;
  onChange: (patch: Partial<GraphicsSettings>) => void;
  onClearShaderCache: () => void;
}

export function GraphicsScreen({ settings, adapter, onChange, onClearShaderCache }: GraphicsScreenProps) {
  const isWeakAdapter = adapter?.isFallback === true;
  // Recommended scale follows Part 1.2's per-title guidance, generalised: a
  // fallback adapter is the case where native resolution is not reachable.
  const recommendedScale = isWeakAdapter ? 0.5 : 1.0;
  const guestDrsTypical = 0.8;

  return (
    <>
      <h2>Graphics</h2>
      <p className="lede">
        These settings control the <em>host</em> side only. The guest chooses its own internal render
        resolution dynamically, and the two multiply together.
      </p>

      <Card
        title="Adapter"
        badge={
          adapter ? (
            <Pill tone={isWeakAdapter ? 'warn' : 'ok'}>{isWeakAdapter ? 'fallback' : 'hardware'}</Pill>
          ) : (
            <Pill tone="muted">unknown</Pill>
          )
        }
      >
        {!adapter ? (
          <p className="muted">No adapter information has been reported yet.</p>
        ) : (
          <table>
            <tbody>
              <tr>
                <td className="muted">Vendor</td>
                <td className="num">{adapter.vendor ?? '—'}</td>
              </tr>
              <tr>
                <td className="muted">Architecture</td>
                <td className="num">{adapter.architecture ?? '—'}</td>
              </tr>
              {adapter.description && (
                <tr>
                  <td className="muted">Description</td>
                  <td>{adapter.description}</td>
                </tr>
              )}
              <tr>
                <td className="muted">maxBufferSize</td>
                <td className="num">
                  {adapter.maxBufferSize ? `${(adapter.maxBufferSize / 1024 ** 3).toFixed(2)} GiB` : '—'}
                </td>
              </tr>
              <tr>
                <td className="muted">maxTextureDimension2D</td>
                <td className="num">{adapter.maxTextureDimension2D ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        )}

        {isWeakAdapter && (
          <div className="callout callout-warn" style={{ marginTop: 12 }}>
            <div className="callout-title">Running on a fallback adapter</div>
            <div className="callout-body">
              <p>
                Hardware acceleration is unavailable, so this session will not reach native resolution
                at any playable frame rate. Start at scale 0.5 and treat the result as a correctness
                check, not a performance one.
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card title="Resolution">
        <label className="field">
          <span className="label-text">Host resolution scale</span>
          <div className="range-row">
            <input
              type="range"
              min={0.25}
              max={1}
              step={0.05}
              value={settings.resolutionScale}
              onChange={(e) => onChange({ resolutionScale: Number(e.target.value) })}
            />
            <span className="range-value">{settings.resolutionScale.toFixed(2)}x</span>
          </div>
          <span className="field-hint">
            Renders at {Math.round(settings.resolutionScale * 1280)}x
            {Math.round(settings.resolutionScale * 720)} from a 1280x720 guest framebuffer.
          </span>
        </label>

        {settings.nearestScaling && (
          <div className="callout callout-info">
            <div className="callout-title">Effective resolution with the guest&apos;s own DRS</div>
            <div className="callout-body">
              <p>
                Sword/Shield and Legends pick their internal resolution each frame from the frame time
                they measure. At a typical guest DRS of {guestDrsTypical.toFixed(1)} and your scale of{' '}
                {settings.resolutionScale.toFixed(2)}, the actual render target is{' '}
                <strong>
                  {Math.round(settings.resolutionScale * guestDrsTypical * 1280)}x
                  {Math.round(settings.resolutionScale * guestDrsTypical * 720)}
                </strong>
                . Lowering your scale below 1 does not disable the guest&apos;s DRS; the two multiply.
              </p>
            </div>
          </div>
        )}

        <div className="checkbox-row">
          <input
            id="nearest"
            type="checkbox"
            checked={settings.nearestScaling}
            onChange={(e) => onChange({ nearestScaling: e.target.checked })}
          />
          <label htmlFor="nearest">
            Nearest-neighbour scaling
            <div className="field-hint">
              Pixel-art Pokemon reads noticeably better crisp. Costs some sharpness in 3D scenes.
            </div>
          </label>
        </div>

        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => onChange({ resolutionScale: recommendedScale })}>
            Use recommended ({recommendedScale.toFixed(2)}x)
          </button>
          {settings.resolutionScale !== 1 && (
            <button className="btn btn-sm" onClick={() => onChange({ resolutionScale: 1 })}>
              Native
            </button>
          )}
        </div>
      </Card>

      <Card title="Frame pacing">
        <label className="field">
          <span className="label-text">Vsync mode</span>
          <select value={settings.vsync} onChange={(e) => onChange({ vsync: e.target.value as VsyncMode })}>
            <option value="respect-game">Respect the game&apos;s request (recommended)</option>
            <option value="force-30">Force 30 fps</option>
            <option value="force-60">Force 60 fps</option>
          </select>
          <span className="field-hint">
            A 30 fps-locked title stays at 30 fps regardless of monitor refresh, which leaves roughly
            twice the frame budget. Forcing a rate the guest did not ask for makes its own frame-time
            measurement wrong, and titles with dynamic resolution will respond by pumping the
            resolution.
          </span>
        </label>

        <label className="field">
          <span className="label-text">Frame pacing source</span>
          <select
            value={settings.framePacing}
            onChange={(e) => onChange({ framePacing: e.target.value as FramePacingMode })}
          >
            <option value="audio-master">Audio ring fill (recommended)</option>
            <option value="display-master">Display refresh</option>
          </select>
          <span className="field-hint">
            Audio-master pacing is what decouples guest frame rate from monitor refresh.
            Display-master is exposed for comparison, and on a high-refresh display it lets the guest
            run ahead until the audio buffer starves — the &ldquo;runs great until audio starves, then
            stutters&rdquo; failure mode.
          </span>
        </label>

        <label className="field">
          <span className="label-text">Additional FPS cap</span>
          <div className="range-row">
            <input
              type="range"
              min={0}
              max={120}
              step={5}
              value={settings.fpsCap ?? 0}
              onChange={(e) =>
                onChange({ fpsCap: Number(e.target.value) === 0 ? null : Number(e.target.value) })
              }
            />
            <span className="range-value">{settings.fpsCap ?? 'none'}</span>
          </div>
          <span className="field-hint">
            An extra ceiling on top of the guest&apos;s requested interval.
          </span>
        </label>
      </Card>

      <Card title="Shader cache" badge={<Pill tone="muted">not yet populated</Pill>}>
        <p>
          Translated WGSL and driver pipeline binaries are cached per title, keyed by title, shader
          hash, translator version, and adapter fingerprint. Once warm, a session should compile zero
          shaders.
        </p>
        <p className="field-hint">
          Because the adapter fingerprint is part of the key, switching GPUs invalidates the cache.
          That is deliberate: a pipeline binary from a different driver is not merely stale, it is
          wrong.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={onClearShaderCache} disabled>
            Clear shader cache (no cache yet)
          </button>
        </div>
      </Card>
    </>
  );
}
