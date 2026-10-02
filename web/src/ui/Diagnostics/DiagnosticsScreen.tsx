// web/src/ui/Diagnostics/DiagnosticsScreen.tsx
//
// Part 3.9's profiling overlay and Part 3.10's diagnostics screen.
//
// The instruction that shapes this screen: "Making regression and cache health
// visible is how a project like this stays honest." So it shows measured values and
// verdicts, never reassurance. Where a number is not yet measured it says so, and
// the Phase 0 gate table reports "not met" rather than hiding an unmet gate behind
// an overall green state.

import { useCallback, useMemo, useState } from 'react';
import { Callout, CapabilityRow, Card, GateRow, LogView, Pill, formatBytes, formatFeatures } from '../components';
import { WORKER_LABEL } from '../../platform/protocol';
import {
  SW_ARENA_DEFAULT_BYTES,
  SW_ARENA_MAX_BYTES,
  SW_FEATURE_SIMD128,
  SW_FEATURE_BULK_MEMORY,
  SW_FEATURE_TAIL_CALL,
  SW_FEATURE_SHARED_MEMORY,
  SW_FEATURE_SIGN_EXT,
} from '@gen/abi';

/**
 * The feature bitmap -> names mapping, as a plain object.
 *
 * `SW_FEATURE` from gen/abi is keyed by the C macro names, which is right for the
 * generator's output but awkward to hand to a formatter. This is the display
 * mapping, kept here so the generated file stays purely mechanical.
 */
const FEATURE_NAMES: Record<string, number> = {
  SIMD128: SW_FEATURE_SIMD128,
  BULK_MEMORY: SW_FEATURE_BULK_MEMORY,
  TAIL_CALL: SW_FEATURE_TAIL_CALL,
  SHARED_MEMORY: SW_FEATURE_SHARED_MEMORY,
  SIGN_EXT: SW_FEATURE_SIGN_EXT,
};
import type { Capabilities } from '../../platform/capabilities';
import type { LogEntry, WorkerBootInfo } from '../../platform/workerHost';
import type { GateResult } from '../../state/appState';
import type { GpuAdapterReply } from '../../platform/protocol';

interface DiagnosticsScreenProps {
  capabilities: Capabilities | null;
  boots: WorkerBootInfo[];
  adapter: GpuAdapterReply | null;
  logs: LogEntry[];
  gates: GateResult[];
  roundTrip: { p50: number; p95: number; max: number; samples: number } | null;
  onRemeasure: () => Promise<void>;
}

export function DiagnosticsScreen({
  capabilities,
  boots,
  adapter,
  logs,
  gates,
  roundTrip,
  onRemeasure,
}: DiagnosticsScreenProps) {
  const [copied, setCopied] = useState(false);
  const [measuring, setMeasuring] = useState(false);

  const workerMask = capabilities?.crossOriginIsolated === true;

  const regions = useMemo(() => {
    const all = boots.flatMap((b) => (b.regions ?? []).map((r) => ({ ...r, worker: b.kind })));
    // De-duplicate by region id: every worker reserves the same region set, so
    // showing all four copies would be noise. The CPU worker's copy is canonical.
    const seen = new Map<number, (typeof all)[number]>();
    for (const region of all) {
      if (!seen.has(region.id)) seen.set(region.id, region);
    }
    return [...seen.values()].sort((a, b) => a.id - b.id);
  }, [boots]);

  const buildReport = useCallback((): string => {
    const lines: string[] = [];
    lines.push('switch-web diagnostics');
    lines.push(`generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## platform');
    lines.push(`userAgent: ${navigator.userAgent}`);
    lines.push(`crossOriginIsolated: ${capabilities?.crossOriginIsolated}`);
    lines.push(`SharedArrayBuffer: ${capabilities?.sharedArrayBuffer}`);
    lines.push(`WebGPU: ${capabilities?.webGpu}`);
    lines.push(`File System Access: ${capabilities?.fileSystemAccess}`);
    lines.push(`OffscreenCanvas: ${capabilities?.offscreenCanvas}`);
    lines.push(`AudioWorklet: ${capabilities?.audioWorklet}`);
    lines.push('');

    lines.push('## gpu adapter');
    if (adapter) {
      lines.push(`available: ${adapter.available}`);
      lines.push(`vendor: ${adapter.vendor ?? 'n/a'}`);
      lines.push(`architecture: ${adapter.architecture ?? 'n/a'}`);
      lines.push(`description: ${adapter.description ?? 'n/a'}`);
      lines.push(`isFallbackAdapter: ${adapter.isFallback ?? 'n/a'}`);
      lines.push(`maxBufferSize: ${adapter.maxBufferSize ?? 'n/a'}`);
      lines.push(`maxTextureDimension2D: ${adapter.maxTextureDimension2D ?? 'n/a'}`);
      if (adapter.reason) lines.push(`reason: ${adapter.reason}`);
    } else {
      lines.push('(not probed)');
    }
    lines.push('');

    lines.push('## workers');
    for (const boot of boots) {
      lines.push(`### ${WORKER_LABEL[boot.kind]}`);
      lines.push(`booted: ${boot.booted}`);
      lines.push(`buildId: ${boot.buildId ?? 'n/a'}`);
      lines.push(`abiVersion: ${boot.abiVersion ?? 'n/a'}`);
      lines.push(`features: ${boot.features ?? 0} (${formatFeatures(boot.features, FEATURE_NAMES)})`);
      lines.push(`arena: ${boot.arenaBytes ?? 0} bytes, ${boot.arenaUsedBytes ?? 0} used`);
      lines.push(`shared memory: ${boot.isSharedMemory ?? false}`);
      if (boot.error) lines.push(`error: ${boot.error.message}`);
    }
    lines.push('');

    lines.push('## phase 0 gates');
    for (const gate of gates) {
      lines.push(`${gate.passed ? 'PASS' : 'NOT MET'}  ${gate.label} — ${gate.measured} (requires ${gate.requirement})`);
    }
    lines.push('');

    lines.push('## round trip');
    if (roundTrip) {
      lines.push(`samples: ${roundTrip.samples}`);
      lines.push(`p50: ${roundTrip.p50.toFixed(4)} ms`);
      lines.push(`p95: ${roundTrip.p95.toFixed(4)} ms`);
      lines.push(`max: ${roundTrip.max.toFixed(4)} ms`);
    } else {
      lines.push('(not measured)');
    }
    lines.push('');

    lines.push('## arena regions (first worker that reserved each)');
    for (const region of regions) {
      lines.push(
        `${region.name.padEnd(28)} offset=${String(region.offset).padStart(10)} size=${String(region.size).padStart(10)} flags=0x${region.flags.toString(16)}`,
      );
    }
    lines.push('');

    lines.push('## worker log');
    for (const entry of logs.slice(-200)) {
      lines.push(`[${WORKER_LABEL[entry.kind] ?? 'main'}] ${entry.level}: ${entry.message}`);
    }

    return lines.join('\n');
  }, [capabilities, boots, adapter, gates, roundTrip, regions, logs]);

  // Materialised once per render pass so the textarea and the clipboard button
  // cannot disagree about what "diagnostics" means.
  const rawReport = buildReport();

  const copyDiagnostics = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rawReport);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the textarea below is the fallback and is
      // always present so the text is never trapped in a failed write.
      setCopied(false);
    }
  }, [rawReport]);

  const remeasure = useCallback(async () => {
    setMeasuring(true);
    try {
      await onRemeasure();
    } finally {
      setMeasuring(false);
    }
  }, [onRemeasure]);

  const gatesPassed = gates.filter((g) => g.passed).length;

  return (
    <>
      <h2>Diagnostics</h2>
      <p className="lede">
        Everything here is measured at runtime. Nothing is estimated or hard-coded, so a green result
        means the check actually ran.
      </p>

      <Card
        title="Phase 0 gates"
        badge={
          <Pill tone={gatesPassed === gates.length ? 'ok' : 'warn'}>
            {gatesPassed}/{gates.length} passing
          </Pill>
        }
      >
        <table>
          <tbody>
            {gates.map((gate) => (
              <GateRow key={gate.id} gate={gate} />
            ))}
          </tbody>
        </table>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void remeasure()} disabled={measuring}>
            {measuring ? 'Measuring…' : 'Re-measure round trip'}
          </button>
          <button className="btn" onClick={() => void copyDiagnostics()}>
            {copied ? 'Copied' : 'Copy diagnostics'}
          </button>
        </div>

        {roundTrip && (
          <pre style={{ marginTop: 12 }}>
            {`samples  ${roundTrip.samples}
p50      ${roundTrip.p50.toFixed(4)} ms
p95      ${roundTrip.p95.toFixed(4)} ms
max      ${roundTrip.max.toFixed(4)} ms
budget   1.0000 ms  →  ${roundTrip.p95 < 1 ? 'PASS' : 'FAIL'}`}
          </pre>
        )}
      </Card>

      <Card title="Platform capabilities">
        {!capabilities ? (
          <p className="muted">Capabilities have not been probed.</p>
        ) : (
          <table>
            <tbody>
              {capabilities.list.map((capability) => (
                <CapabilityRow key={capability.id} capability={capability} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="WebGPU adapter">
        {!adapter ? (
          <p className="muted">No adapter has been probed yet.</p>
        ) : !adapter.available ? (
          <Callout tone="err" title="WebGPU adapter unavailable">
            <p>{adapter.reason}</p>
          </Callout>
        ) : (
          <table>
            <tbody>
              <tr>
                <td className="muted">vendor</td>
                <td className="num">{adapter.vendor ?? '—'}</td>
              </tr>
              <tr>
                <td className="muted">architecture</td>
                <td className="num">{adapter.architecture ?? '—'}</td>
              </tr>
              {adapter.description && (
                <tr>
                  <td className="muted">description</td>
                  <td>{adapter.description}</td>
                </tr>
              )}
              <tr>
                <td className="muted">fallback</td>
                <td className="num">{String(adapter.isFallback ?? false)}</td>
              </tr>
              <tr>
                <td className="muted">maxBufferSize</td>
                <td className="num">{formatBytes(adapter.maxBufferSize)}</td>
              </tr>
              <tr>
                <td className="muted">maxTextureDimension2D</td>
                <td className="num">{adapter.maxTextureDimension2D ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Workers" badge={<Pill tone={boots.every((b) => b.booted) ? 'ok' : 'warn'}>{boots.filter((b) => b.booted).length}/{boots.length}</Pill>}>
        <table>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Status</th>
              <th>Build</th>
              <th>Arena</th>
              <th>Shared</th>
            </tr>
          </thead>
          <tbody>
            {boots.map((boot) => (
              <tr key={boot.kind}>
                <td>{WORKER_LABEL[boot.kind]}</td>
                <td>
                  {boot.booted ? (
                    <Pill tone="ok">booted</Pill>
                  ) : boot.error ? (
                    <Pill tone="err">failed</Pill>
                  ) : (
                    <Pill tone="muted">idle</Pill>
                  )}
                  {boot.error && (
                    <div className="field-hint" style={{ marginTop: 4, maxWidth: 320 }}>
                      {boot.error.message}
                    </div>
                  )}
                </td>
                <td className="compat-title">
                  {boot.buildId ?? '—'}
                  {boot.abiVersion !== undefined && (
                    <div className="muted">ABI v{boot.abiVersion}</div>
                  )}
                </td>
                <td className="num">
                  {formatBytes(boot.arenaBytes)}
                  {boot.arenaUsedBytes !== undefined && (
                    <div className="muted">{formatBytes(boot.arenaUsedBytes)} used</div>
                  )}
                </td>
                <td>{boot.isSharedMemory ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Arena regions"
        badge={<Pill tone="muted">{regions.length} reserved</Pill>}
      >
        {!workerMask ? (
          <p className="muted">Cross-origin isolation is off, so no shared arena exists.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Offset</th>
                  <th>Size</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {regions.map((region) => (
                  <tr key={`${region.worker}-${region.id}`}>
                    <td className="compat-title">{region.name}</td>
                    <td className="num">{region.offset}</td>
                    <td className="num">{formatBytes(region.size)}</td>
                    <td className="num">0x{region.flags.toString(16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint" style={{ marginTop: 10 }}>
              Default arena {formatBytes(SW_ARENA_DEFAULT_BYTES)}, hard ceiling{' '}
              {formatBytes(SW_ARENA_MAX_BYTES)}. The ceiling sits below the wasm32 4 GiB limit so there
              is room for JIT code, audio rings, and the host&apos;s own allocations.
            </p>
          </>
        )}
      </Card>

      <Card title="Not yet instrumented" badge={<Pill tone="muted">later phases</Pill>}>
        <p>
          These counters are defined in Part 3.9 and none of them exist yet, because the subsystems
          they measure do. They will appear here as each phase lands.
        </p>
        <ul className="dim" style={{ margin: 0, paddingLeft: 20 }}>
          <li>CPU: block-cache hit rate, superblock compiles, interpreter fallback %, guest MIPS</li>
          <li>GPU: draws/frame, PSO changes/frame, pipeline compiles (cached vs live), bytes uploaded</li>
          <li>Memory: resident pages, TLB hit rate, arena usage</li>
          <li>Audio: ring fill %, underruns/sec (the tone test does report these)</li>
          <li>Frame: total guest frame time with a breakdown</li>
        </ul>
      </Card>

      <Card
        title="Worker log"
        badge={<Pill tone="muted">{logs.length} entries</Pill>}
      >
        <LogView entries={logs} limit={300} />
      </Card>

      <Card title="Raw diagnostics" badge={<Pill tone="muted">for bug reports</Pill>}>
        <p className="field-hint">
          This is exactly what &ldquo;Copy diagnostics&rdquo; puts on the clipboard. It contains no key
          material and no user content.
        </p>
        <textarea
          readOnly
          value={rawReport}
          rows={20}
          aria-label="Diagnostics report"
          style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
        />
      </Card>
    </>
  );
}
