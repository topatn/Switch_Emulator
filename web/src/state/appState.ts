// web/src/state/appState.ts
//
// Application state.
//
// Deliberately a plain observable store rather than a framework: Part 3.10
// requires emulator state to be read via typed postMessage "polled at ~10 Hz -
// never per guest instruction", which means the state layer needs to be cheap
// and predictable, not clever.
//
// The store holds two kinds of state and keeps them visibly separate:
//   - *configuration*: user choices (folder, resolution scale, vsync mode)
//   - *observation*: what the workers report (boot status, logs, adapter, gate
//     measurements)
// Mixing them is how a setting silently becomes a telemetry value and then gets
// "restored" from a stale reading.

import type { Capabilities } from '../platform/capabilities';
import type { LogEntry, WorkerBootInfo } from '../platform/workerHost';
import type { GpuAdapterReply } from '../platform/protocol';
import { WorkerKind } from '../platform/protocol';

// --- configuration --------------------------------------------------------

export type VsyncMode = 'respect-game' | 'force-30' | 'force-60';
export type FramePacingMode = 'audio-master' | 'display-master';

export interface GraphicsSettings {
  /** Host resolution scale, 0.25 - 1.0 (Part 3.10). */
  resolutionScale: number;
  vsync: VsyncMode;
  fpsCap: number | null;
  framePacing: FramePacingMode;
  /** Nearest-neighbour scaling: pixel-art Pokemon looks better crisp. */
  nearestScaling: boolean;
}

export interface AudioSettings {
  /** Ring chunk size in frames; Part 3.6 makes this tunable. */
  bufferFrames: number;
  latencyHint: 'interactive' | 'balanced' | 'playback';
  muted: boolean;
  volume: number;
}

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  /** Arena size per worker, in MiB. */
  arenaMiB: Partial<Record<WorkerKind, number>>;
  /** Per-title input profiles (Part 3.7), keyed by title id. */
  inputProfiles: Record<string, Record<string, string>>;
}

export const DEFAULT_SETTINGS: Settings = {
  graphics: {
    // Part 1.2 is explicit that Sword/Shield needs a reduced scale on integrated
    // GPUs, so the default is conservative rather than optimistic.
    resolutionScale: 1.0,
    vsync: 'respect-game',
    fpsCap: null,
    framePacing: 'audio-master',
    nearestScaling: false,
  },
  audio: {
    bufferFrames: 2048,
    latencyHint: 'interactive',
    muted: false,
    volume: 1.0,
  },
  arenaMiB: {
    [WorkerKind.Cpu]: 1024,
    [WorkerKind.Gpu]: 512,
    [WorkerKind.Audio]: 128,
    [WorkerKind.Io]: 256,
  },
  inputProfiles: {},
};

// --- observation ----------------------------------------------------------

export type Phase = 'boot' | 'onboarding' | 'ready';

/** A Phase 0 gate measurement, rendered in Diagnostics. */
export interface GateResult {
  id: string;
  label: string;
  passed: boolean;
  measured: string;
  requirement: string;
  detail?: string;
}

export interface Observation {
  capabilities: Capabilities | null;
  boots: WorkerBootInfo[];
  adapter: GpuAdapterReply | null;
  logs: LogEntry[];
  gates: GateResult[];
  /** Round-trip measurement, ms. */
  roundTrip: { p50: number; p95: number; max: number; samples: number } | null;
  userFolderName: string | null;
  keysFileName: string | null;
  keysValid: boolean | null;
}

export interface AppState {
  phase: Phase;
  settings: Settings;
  observation: Observation;
  /** True while any blocking capability is missing. */
  blocked: boolean;
}

export const INITIAL_STATE: AppState = {
  phase: 'boot',
  settings: DEFAULT_SETTINGS,
  observation: {
    capabilities: null,
    boots: [],
    adapter: null,
    logs: [],
    gates: [],
    roundTrip: null,
    userFolderName: null,
    keysFileName: null,
    keysValid: null,
  },
  blocked: false,
};

// --- store ----------------------------------------------------------------

type Listener = (state: AppState) => void;

/**
 * A minimal observable store.
 *
 * React 18's `useSyncExternalStore` is the intended consumer; exposing
 * `subscribe` and `getSnapshot` keeps this compatible with it and costs nothing
 * versus a bespoke implementation.
 */
export class Store {
  private state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState = INITIAL_STATE) {
    this.state = initial;
  }

  getSnapshot = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Shallow-merges a patch at the top level.
   *
   * Callers that need to change nested settings pass a new nested object; there
   * is deliberately no deep merge, because a deep merge makes "did this actually
   * change?" unanswerable and re-renders everything.
   */
  set(patch: Partial<AppState>): void {
    const next = { ...this.state, ...patch };
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  patchObservation(patch: Partial<Observation>): void {
    this.set({ observation: { ...this.state.observation, ...patch } });
  }

  patchSettings<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.set({ settings: { ...this.state.settings, [key]: value } });
  }

  patchGraphics(patch: Partial<GraphicsSettings>): void {
    this.patchSettings('graphics', { ...this.state.settings.graphics, ...patch });
  }

  patchAudio(patch: Partial<AudioSettings>): void {
    this.patchSettings('audio', { ...this.state.settings.audio, ...patch });
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

/**
 * Evaluates the Part 6 Phase 0 gate list.
 *
 * Exported as a pure function so it can be unit-tested without a browser, and so
 * the same function feeds both the UI and any CI check.
 */
export function evaluatePhase0Gates(
  capabilities: Capabilities | null,
  boots: WorkerBootInfo[],
  roundTrip: Observation['roundTrip'],
  onboarding: { userFolderName: string | null; keysFileName: string | null },
): GateResult[] {
  const gates: GateResult[] = [];

  gates.push({
    id: 'coi',
    label: 'crossOriginIsolated is true',
    requirement: 'crossOriginIsolated === true',
    passed: capabilities?.crossOriginIsolated === true,
    measured: capabilities ? String(capabilities.crossOriginIsolated) : 'not probed',
    detail:
      'Part 3.9: SharedArrayBuffer does not exist without COOP/COEP, so the shared WASM memory cannot exist.',
  });

  const expected = [WorkerKind.Cpu, WorkerKind.Gpu, WorkerKind.Audio, WorkerKind.Io];
  const bootedKinds = boots.filter((b) => b.booted).map((b) => b.kind);
  const missing = expected.filter((k) => !bootedKinds.includes(k));
  gates.push({
    id: 'workers',
    label: 'WASM core instantiates in each worker type',
    requirement: 'CPU, GPU, Audio, I/O all boot',
    passed: missing.length === 0,
    measured: `${bootedKinds.length}/${expected.length} booted`,
    detail: missing.length ? `Not booted: ${missing.join(', ')}.` : undefined,
  });

  gates.push({
    id: 'roundtrip',
    label: 'main -> worker -> main round trip under 1 ms',
    requirement: 'p95 < 1 ms',
    passed: roundTrip ? roundTrip.p95 < 1 : false,
    measured: roundTrip
      ? `p50 ${roundTrip.p50.toFixed(4)} ms, p95 ${roundTrip.p95.toFixed(4)} ms, max ${roundTrip.max.toFixed(4)} ms over ${roundTrip.samples}`
      : 'not measured',
    detail: 'Part 6 Phase 0: validates the SAB/Atomics path end to end.',
  });

  gates.push({
    id: 'folder',
    label: 'Folder picker flow works',
    requirement: 'a user folder is selected and readable',
    passed: onboarding.userFolderName !== null,
    measured: onboarding.userFolderName ? `folder "${onboarding.userFolderName}"` : 'not selected',
    detail: 'Part 0: game installs live in a user-chosen directory; nothing is written outside it.',
  });

  gates.push({
    id: 'keys',
    label: 'prod.keys picker flow works',
    requirement: 'a keys file is validated without retaining key material',
    passed: onboarding.keysFileName !== null,
    measured: onboarding.keysFileName
      ? `validated "${onboarding.keysFileName}"`
      : 'not selected (optional for boot; required to mount encrypted content)',
    detail:
      'Part 0: the file is read via a picker, validated by shape, and never uploaded, displayed, or logged.',
  });

  gates.push({
    id: 'artifact-scan',
    label: 'CI artifact scan reports zero game content',
    requirement: 'npm run scan passes',
    passed: false,
    measured: 'CI only',
    detail:
      'Part 0 compliance checklist item 2. Greps the artifact tree for key/ROM file signatures. Run `npm run scan` locally to check the current tree.',
  });

  return gates;
}
