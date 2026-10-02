// web/src/main.tsx
//
// Application entry point and boot orchestration.
//
// The boot sequence is deliberately explicit and sequential, because each step
// depends on the previous one and a race here produces the worst possible
// failure mode: a UI that looks fine and a core that is not actually running.
//
// Order:
//   1. Probe platform capabilities (Part 3.9). Nothing else may assume they exist.
//   2. Boot the four workers, each with its own WASM core instance.
//   3. Measure the main -> worker -> main round trip (Phase 0 gate).
//   4. Restore any previously granted folder handle.
//   5. Decide the phase: blocked, onboarding, or ready.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { detectCapabilities } from './platform/capabilities';
import { WorkerHost } from './platform/workerHost';
import { checkFolderPermission } from './platform/folderHandle';
import { Store, evaluatePhase0Gates, type Observation } from './state/appState';
import type { LogEntry } from './platform/workerHost';
import { WorkerKind } from './platform/protocol';
import { coreBaseUrl, CORE_BUILD_NOTE } from './core/coreUrl';
import { createAudioRing } from './platform/audio';
import './ui/styles.css';

const store = new Store();
const root = createRoot(document.getElementById('root')!);

function render(): void {
  root.render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
}

render();

// --- boot -----------------------------------------------------------------

/**
 * Where core.wasm / core.js live.
 *
 * Resolved relative to the app's own base so a deployed build at any mount point
 * finds it. `import.meta.env.BASE_URL` is Vite's configured base ('./' here),
 * which normalises to the directory the app was served from.
 */
async function boot(): Promise<void> {
  const capabilities = await detectCapabilities();
  store.patchObservation({ capabilities });
  store.set({ blocked: !capabilities.usable });

  // The audio ring is allocated here, on the main thread, because the
  // AudioWorklet that consumes it must be constructed where AudioContext exists.
  // Null when the platform is not cross-origin isolated, in which case audio is
  // disabled and the audio worker reports that rather than failing.
  const ring = capabilities.sharedArrayBuffer ? createAudioRing() : null;

  if (!capabilities.usable) {
    // Stop here. Booting workers without SharedArrayBuffer would produce a
    // cascade of confusing errors instead of one clear diagnosis.
    render();
    return;
  }

  const host = new WorkerHost(coreBaseUrl, ring?.sab, (entry: LogEntry) => {
    // Cheap path: append to the existing array rather than triggering a store
    // write per log line. Diagnostics re-renders on a timer, not per line.
    const obs = store.getSnapshot().observation;
    obs.logs.push(entry);
  });

  try {
    await host.bootAll();
  } catch (error) {
    render();
    void error;
    return;
  }

  store.patchObservation({ boots: host.allBootInfo() });
  store.patchObservation({ adapter: await host.adapter().catch(() => null) });

  // Phase 0 gate measurement.
  let roundTrip: Observation['roundTrip'] = null;
  try {
    const result = await host.measureRoundTrip(64);
    roundTrip = { ...result, samples: 64 };
  } catch {
    roundTrip = null;
  }
  store.patchObservation({ roundTrip });

  // Restore a previously granted folder, if there is one.
  let folderName: string | null = null;
  try {
    const permission = await checkFolderPermission();
    if (permission?.state === 'granted') {
      const { loadDirectoryHandle } = await import('./platform/folderHandle');
      const handle = await loadDirectoryHandle();
      folderName = handle?.name ?? null;
      if (folderName) host.request(WorkerKind.Io, { type: 'restore-folder', seq: 0 }).catch(() => undefined);
    }
  } catch {
    folderName = null;
  }
  store.patchObservation({ userFolderName: folderName });

  // Phase: onboarding until we have a folder, since a folder is the first thing
  // a user needs and its absence blocks everything downstream.
  store.set({ phase: folderName ? 'ready' : 'onboarding' });

  store.patchObservation({
    gates: evaluatePhase0Gates(capabilities, host.allBootInfo(), roundTrip, {
      userFolderName: folderName,
      keysFileName: store.getSnapshot().observation.keysFileName,
    }),
  });

  render();

  if (CORE_BUILD_NOTE) {
    hostLog(store, CORE_BUILD_NOTE);
  }

  // Wire the shell to the worker log. The store owns the log array so Diagnostics
  // has a single source of truth; the host pushes entries as they arrive.
  host.subscribeLogs((logs) => {
    store.patchObservation({ logs: [...logs] });
  });
}

function hostLog(target: Store, message: string): void {
  target.patchObservation({
    logs: [
      ...target.getSnapshot().observation.logs,
      {
        id: -1,
        // Sourced from the main thread rather than a worker. WorkerKind.Cpu is used
        // as the source column value purely so the log renders consistently.
        kind: 1 as WorkerKind,
        level: 'info',
        message,
        at: performance.now(),
      },
    ],
  });
}

void boot();

// Re-evaluate gates whenever the onboarding state changes, so a gate flips to
// passing the moment the user picks a folder rather than on the next reload.
let lastGateKey = '';
setInterval(() => {
  const state = store.getSnapshot();
  const obs = state.observation;
  const key = `${obs.userFolderName}|${obs.keysFileName}|${obs.roundTrip?.p95 ?? ''}|${obs.boots
    .map((b) => (b.booted ? 1 : 0))
    .join('')}|${obs.capabilities?.crossOriginIsolated}`;
  if (key === lastGateKey) return;
  lastGateKey = key;
  store.patchObservation({
    gates: evaluatePhase0Gates(obs.capabilities, obs.boots, obs.roundTrip, {
      userFolderName: obs.userFolderName,
      keysFileName: obs.keysFileName,
    }),
  });
}, 500);
