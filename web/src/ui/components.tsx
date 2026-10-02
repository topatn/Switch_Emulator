// web/src/ui/components.tsx
//
// Small presentational primitives shared across the screens.
//
// Part 3.10's framing for this UI — "Not decoration — this is how a user
// understands why a title won't boot yet" — means these components carry
// meaning: a Pill states a verdict, a Callout states a consequence and a remedy.
// They are kept dumb and separate from the screens for that reason.

import type { ReactNode } from 'react';
import type { Capability } from '../platform/capabilities';
import type { GateResult } from '../state/appState';
import type { LogEntry } from '../platform/workerHost';
import { WORKER_LABEL } from '../platform/protocol';

export function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'err' | 'muted' | 'accent';
  children: ReactNode;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Card({ title, badge, children }: { title?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || badge) && (
        <div className="card-title">
          {title}
          <span style={{ flex: 1 }} />
          {badge}
        </div>
      )}
      {children}
    </section>
  );
}

export type CalloutTone = 'info' | 'warn' | 'err' | 'ok';

export function Callout({
  tone,
  title,
  children,
}: {
  tone: CalloutTone;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === 'err' ? 'alert' : undefined}>
      {title && <div className="callout-title">{title}</div>}
      <div className="callout-body">{children}</div>
    </div>
  );
}

/** A capability row: what it is, whether it works, and what to do if not. */
export function CapabilityRow({ capability }: { capability: Capability }) {
  const tone = capability.status === 'ok' ? 'ok' : capability.status === 'missing' ? 'err' : 'warn';
  const pillTone = tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : 'warn';
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: 8 }}>
          <strong>{capability.label}</strong>
          {capability.blocking && <Pill tone="muted">required</Pill>}
        </div>
        <div className="muted" style={{ marginTop: 3 }}>
          {capability.detail}
        </div>
        {capability.remedy && (
          <div className="field-hint" style={{ marginTop: 5 }}>
            {capability.remedy}
          </div>
        )}
      </td>
      <td style={{ width: 120, textAlign: 'right' }}>
        <Pill tone={pillTone}>{capability.status}</Pill>
      </td>
    </tr>
  );
}

/** A Phase 0 gate row. `passed` is a verdict, not a progress bar. */
export function GateRow({ gate }: { gate: GateResult }) {
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: 8 }}>
          <strong>{gate.label}</strong>
        </div>
        <div className="muted mono" style={{ marginTop: 3 }}>
          {gate.measured}
        </div>
        {gate.detail && (
          <div className="field-hint" style={{ marginTop: 5 }}>
            {gate.detail}
          </div>
        )}
      </td>
      <td style={{ width: 170 }}>
        <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 4 }}>
          requires: {gate.requirement}
        </div>
        <Pill tone={gate.passed ? 'ok' : 'warn'}>{gate.passed ? 'pass' : 'not met'}</Pill>
      </td>
    </tr>
  );
}

/**
 * The worker log.
 *
 * Capped and virtualised by slice rather than by a full virtualiser: the ring
 * already bounds the log at 500 entries, and a real virtualiser here would add a
 * dependency for no benefit at that size.
 */
export function LogView({ entries, limit = 250 }: { entries: LogEntry[]; limit?: number }) {
  const visible = entries.slice(-limit);
  if (visible.length === 0) {
    return <div className="muted" style={{ padding: '8px 12px' }}>No messages yet.</div>;
  }
  return (
    <div className="log-list" role="log" aria-live="polite">
      {visible.map((entry) => (
        <div key={entry.id} className={`log-line log-${entry.level}`}>
          <span className="log-source">{WORKER_LABEL[entry.kind] ?? 'main'}</span>
          <span className="log-text">{entry.message}</span>
        </div>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="working" />;
}

/** Renders byte counts with the units a user would say out loud. */
export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

/** Decodes the ABI feature bitmap into readable names. */
export function formatFeatures(bits: number | undefined, known: Record<string, number>): string {
  if (!bits) return '—';
  const names = Object.entries(known)
    .filter(([, bit]) => (bits & bit) !== 0)
    .map(([name]) => name.replace('SW_FEATURE_', '').toLowerCase());
  return names.length ? names.join(', ') : 'none';
}
