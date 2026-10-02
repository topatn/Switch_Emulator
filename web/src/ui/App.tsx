// web/src/ui/App.tsx
//
// The shell (Part 3.10).
//
// Structure follows the spec's screen list, with two deliberate omissions worth
// naming:
//
//   * No global modal. Part 3.9's profiling overlay is worker-resident, and
//     rendering it here would sample the main thread and distort what it measures.
//     Diagnostics is a screen instead, plus an F2 shortcut that navigates to it.
//   * No session/emulator surface. Part 1 is candid that Phase 0 emulates
//     nothing, so a play area that cannot play would be theatre.
//
// What the shell *does* own, per Part 3.10: "Main thread = UI + present handoff +
// input listeners. It never runs emulation or blocking I/O."

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LibraryScreen } from './Library/LibraryScreen';
import { OnboardingScreen } from './Onboarding/OnboardingScreen';
import { ControllerScreen } from './Controller/ControllerScreen';
import { GraphicsScreen } from './Graphics/GraphicsScreen';
import { AudioScreen } from './Audio/AudioScreen';
import { SavesScreen } from './Saves/SavesScreen';
import { KeysScreen } from './Keys/KeysScreen';
import { DiagnosticsScreen } from './Diagnostics/DiagnosticsScreen';
import { Callout, Card, Pill, Spinner } from './components';
import { ISOLATION_SNIPPET, type Capabilities } from '../platform/capabilities';
import type { Store } from '../state/appState';
import type { GamepadPreset, StickSettings } from '../platform/input';
import { DEFAULT_KEYBOARD_LAYOUT, DEFAULT_GAMEPAD_LAYOUT, DEFAULT_APP_LAYOUT, DEFAULT_STICK } from '../platform/input';
import { HID_STATE_BYTES } from '../platform/hidState';
import { WorkerKind, type KeysSummaryMessage } from '../platform/protocol';
import { WorkerHost } from '../platform/workerHost';
import { coreBaseUrl } from '../core/coreUrl';
import { AudioOutput, createAudioRing, EMPTY_AUDIO_STATUS, type AudioStatus } from '../platform/audio';

type Tab =
  | 'library'
  | 'controller'
  | 'graphics'
  | 'audio'
  | 'saves'
  | 'keys'
  | 'diagnostics';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'library', label: 'Library' },
  { id: 'controller', label: 'Controller' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'audio', label: 'Audio' },
  { id: 'saves', label: 'Saves' },
  { id: 'keys', label: 'Keys' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export function App({ store }: { store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<Tab>('library');

  /**
   * The audio ring, allocated once on the main thread.
   *
   * Main-thread allocation is required, not a convenience: the AudioWorklet that
   * reads this ring can only be created where `AudioContext` exists, and
   * `AudioContext` is not exposed in dedicated workers. See web/src/platform/audio.ts.
   *
   * Declared before the host because the host needs the ring on its boot message.
   */
  const audioRing = useMemo(() => createAudioRing(), []);

  // The host is created once. Recreating it on a render would spawn four new
  // workers, so it is held in a ref and never in state.
  const hostRef = useRef<WorkerHost | null>(null);
  if (hostRef.current === null) hostRef.current = new WorkerHost(coreBaseUrl, audioRing?.sab);

  const [folderBusy, setFolderBusy] = useState(false);
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysSummary, setKeysSummary] = useState<KeysSummaryMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyboardLayout, setKeyboardLayout] = useState<Record<string, string>>({ ...DEFAULT_KEYBOARD_LAYOUT });
  const [gamepadLayout, setGamepadLayout] = useState<Record<string, string>>({ ...DEFAULT_GAMEPAD_LAYOUT });
  const [appLayout, setAppLayout] = useState<Record<string, string>>({ ...DEFAULT_APP_LAYOUT });
  const [stick, setStick] = useState<StickSettings>({ ...DEFAULT_STICK });
  const [preset, setPreset] = useState<GamepadPreset>('full');

  const capabilities = state.observation.capabilities;

  // --- keys summary --------------------------------------------------------
  //
  // The I/O worker reports a keys summary as a message, and only the shell owns
  // the store. Having the worker mutate app state would create a second owner,
  // which is the failure mode the whole message-protocol design avoids.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return host.subscribeMessages((msg) => {
      if (msg.type === 'keys-summary') {
        setKeysSummary(msg);
        store.patchObservation({ keysFileName: msg.fileName, keysValid: msg.valid });
      }
    });
  }, [store]);

  // --- folder picker -------------------------------------------------------

  const pickFolder = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    setFolderBusy(true);
    setNotice(null);
    try {
      const handle = await host.pickUserFolder();
      if (!handle) return; // user cancelled
      store.patchObservation({ userFolderName: handle.name });

      // Create the Part 3.8 skeleton immediately, so the user sees where
      // everything goes rather than discovering it on first save.
      const { FolderStore } = await import('../platform/storage');
      const folderStore = await FolderStore.open(handle);
      const created = await folderStore.ensureLayout();
      setNotice(
        created.length > 0
          ? `Created ${created.length} director${created.length === 1 ? 'y' : 'ies'} in "${handle.name}".`
          : `Using existing folder "${handle.name}".`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setFolderBusy(false);
    }
  }, [store]);

  const pickKeys = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    setKeysBusy(true);
    setNotice(null);
    try {
      await host.request(WorkerKind.Io, { type: 'pick-keys', seq: 0 }, 120_000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setKeysBusy(false);
    }
  }, []);

  const clearKeys = useCallback(() => {
    setKeysSummary(null);
    store.patchObservation({ keysFileName: null, keysValid: null });
  }, [store]);

  // --- gate re-measurement -------------------------------------------------

  const remeasure = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    try {
      const result = await host.measureRoundTrip(64);
      store.patchObservation({ roundTrip: { ...result, samples: 64 } });
    } catch {
      store.patchObservation({ roundTrip: null });
    }
  }, [store]);

  // --- shell shortcuts -----------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // F2 toggles the diagnostics surface, per Part 3.7's app-level bindings.
      if (e.code === (appLayout.toggle_overlay ?? 'F2')) {
        e.preventDefault();
        setTab((current) => (current === 'diagnostics' ? 'library' : 'diagnostics'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appLayout.toggle_overlay]);

  const hidSab = useMemo(() => {
    // The HID buffer only exists once the app is cross-origin isolated. Creating
    // it eagerly would throw on a misconfigured host, which is exactly the case
    // the diagnostic screen exists to explain.
    if (typeof SharedArrayBuffer !== 'function') return null;
    if (!globalThis.crossOriginIsolated) return null;
    return new SharedArrayBuffer(HID_STATE_BYTES);
  }, []);

  // The AudioWorklet is started lazily on the first user gesture, because a
  // context created without one starts suspended (the autoplay policy).
  const audioOutputRef = useRef<AudioOutput | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>(EMPTY_AUDIO_STATUS);

  const ensureAudio = useCallback(async () => {
    if (!audioRing) return null;
    if (audioOutputRef.current === null) {
      audioOutputRef.current = new AudioOutput(audioRing, setAudioStatus);
    }
    let status = await audioOutputRef.current.start();
    status = await audioOutputRef.current.resume();
    audioOutputRef.current.setVolume(state.settings.audio.muted ? 0 : state.settings.audio.volume);
    return status;
  }, [audioRing, state.settings.audio.muted, state.settings.audio.volume]);

  // Start audio on the first interaction of any kind. Waiting for a click is the
  // browser's rule, and it is also the moment the user has asked for sound.
  useEffect(() => {
    const onFirstGesture = () => {
      void ensureAudio();
    };
    window.addEventListener('pointerdown', onFirstGesture, { once: true });
    window.addEventListener('keydown', onFirstGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    };
  }, [ensureAudio]);

  // Apply volume changes to the live context.
  useEffect(() => {
    audioOutputRef.current?.setVolume(state.settings.audio.muted ? 0 : state.settings.audio.volume);
  }, [state.settings.audio.muted, state.settings.audio.volume]);

  // Tear the audio graph down when the shell unmounts.
  useEffect(() => {
    return () => {
      void audioOutputRef.current?.close();
    };
  }, []);

  const audioLog = useMemo(() => {
    const entries = state.observation.logs.filter((l) => /audio (ring|producer|run)/i.test(l.message));
    return entries.length ? entries[entries.length - 1]!.message : null;
  }, [state.observation.logs]);

  // --- render --------------------------------------------------------------

  if (state.phase === 'boot') {
    return (
      <div className="app">
        <header className="app-header">
          <div>
            <h1 className="app-title">switch-web</h1>
            <p className="app-subtitle">Browser-native Nintendo Switch emulator</p>
          </div>
        </header>
        <main className="app-main">
          <Callout tone="info" title="Starting up">
            <p>
              Probing platform capabilities, then booting four workers with their own WASM cores.
            </p>
          </Callout>
          <div className="row">
            <Spinner />
            <span className="muted">Booting…</span>
          </div>
        </main>
      </div>
    );
  }

  if (state.blocked) {
    return <BlockedScreen capabilities={capabilities} />;
  }

  if (state.phase === 'onboarding') {
    return (
      <div className="app">
        <header className="app-header">
          <div>
            <h1 className="app-title">switch-web</h1>
            <p className="app-subtitle">First-run setup</p>
          </div>
          <span className="app-header-spacer" />
          <Pill tone="accent">Phase 0</Pill>
        </header>
        <main className="app-main">
          {notice && (
            <Callout tone="warn" title="Notice">
              <p>{notice}</p>
            </Callout>
          )}
          <OnboardingScreen
            folderName={state.observation.userFolderName}
            keysFileName={keysSummary?.fileName ?? null}
            keysValid={keysSummary?.valid ?? null}
            folderBusy={folderBusy}
            keysBusy={keysBusy}
            onPickFolder={() => void pickFolder()}
            onPickKeys={() => void pickKeys()}
            onFinish={() => store.set({ phase: 'ready' })}
          />

          {/*
            Diagnostics stays reachable during onboarding. That is not a
            convenience: a user blocked on the folder picker has no other way to
            find out whether the four workers actually booted, and the Phase 0 gate
            table is exactly the answer. Gating diagnostics behind finishing setup
            would hide the diagnostics from the people who most need them.
          */}
          {tab === 'diagnostics' && (
            <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 24 }}>
              <DiagnosticsScreen
                capabilities={capabilities}
                boots={state.observation.boots}
                adapter={state.observation.adapter}
                logs={state.observation.logs}
                gates={state.observation.gates}
                roundTrip={state.observation.roundTrip}
                onRemeasure={remeasure}
              />
            </div>
          )}
        </main>
        <footer className="app-footer">
          <div className="row">
            <span>
              Bring your own legally-dumped game and keys. Nothing is uploaded, and no game content is
              fetched.
            </span>
            <span className="app-header-spacer" />
            <button className="btn btn-sm" onClick={() => setTab('diagnostics')}>
              Diagnostics
            </button>
          </div>
        </footer>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">switch-web</h1>
          <p className="app-subtitle">Phase 0 foundations — no emulation yet</p>
        </div>
        <span className="app-header-spacer" />
        {state.observation.userFolderName && (
          <Pill tone="muted">folder: {state.observation.userFolderName}</Pill>
        )}
        <Pill tone={state.observation.gates.every((g) => g.passed) ? 'ok' : 'accent'}>
          {state.observation.gates.filter((g) => g.passed).length}/{state.observation.gates.length} gates
        </Pill>
      </header>

      <nav className="app-nav" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? 'page' : undefined}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {notice && (
          <Callout tone="info" title="Notice">
            <p>{notice}</p>
          </Callout>
        )}

        {tab === 'library' && (
          <LibraryScreen
            state={state}
            store={store}
            onPickFolder={() => void pickFolder()}
            folderBusy={folderBusy}
          />
        )}

        {tab === 'controller' && (
          <ControllerScreen
            keyboardLayout={keyboardLayout}
            gamepadLayout={gamepadLayout}
            appLayout={appLayout}
            stick={stick}
            preset={preset}
            onKeyboardLayout={setKeyboardLayout}
            onGamepadLayout={setGamepadLayout}
            onAppLayout={setAppLayout}
            onStick={setStick}
            onPreset={setPreset}
            hidSab={hidSab}
          />
        )}

        {tab === 'graphics' && (
          <GraphicsScreen
            settings={state.settings.graphics}
            adapter={state.observation.adapter?.available ? state.observation.adapter : null}
            onChange={(patch) => store.patchGraphics(patch)}
            onClearShaderCache={() => setNotice('There is no shader cache yet; nothing to clear.')}
          />
        )}

        {tab === 'audio' && (
          <AudioScreen
            settings={state.settings.audio}
            onChange={(patch) => store.patchAudio(patch)}
            status={audioStatus}
            latestLog={audioLog}
            onEnable={() => void ensureAudio()}
          />
        )}

        {tab === 'saves' && (
          <SavesScreen
            folderName={state.observation.userFolderName}
            capabilities={capabilities}
            titles={[]}
          />
        )}

        {tab === 'keys' && (
          <KeysScreen
            folderName={state.observation.userFolderName}
            summary={keysSummary}
            onPickKeys={() => void pickKeys()}
            busy={keysBusy}
            onClearKeys={clearKeys}
          />
        )}

        {tab === 'diagnostics' && (
          <DiagnosticsScreen
            capabilities={capabilities}
            boots={state.observation.boots}
            adapter={state.observation.adapter}
            logs={state.observation.logs}
            gates={state.observation.gates}
            roundTrip={state.observation.roundTrip}
            onRemeasure={remeasure}
          />
        )}
      </main>

      <footer className="app-footer">
        Bring your own legally-dumped game and keys. Nothing is uploaded, and no game content is
        fetched. F2 toggles diagnostics.
      </footer>
    </div>
  );
}

/**
 * The blocked screen.
 *
 * Part 3.9: "a boot-time check of crossOriginIsolated that shows a clear
 * 'your host is missing COOP/COEP' diagnostic with a copy-pasteable snippet and a
 * serve.mjs one-liner."
 *
 * It replaces the app entirely. A shell that renders but cannot do anything is more
 * confusing than a page that says exactly what is wrong.
 */
function BlockedScreen({ capabilities }: { capabilities: Capabilities | null }) {
  const blocking = capabilities?.list.filter((c) => c.blocking && c.status !== 'ok') ?? [];

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">switch-web</h1>
          <p className="app-subtitle">Cannot start on this host</p>
        </div>
      </header>
      <main className="app-main">
        <Callout tone="err" title="The emulation core cannot run here">
          <p>
            One or more required platform capabilities are missing. Nothing below is optional, so the
            shell will not start rather than fail confusingly later.
          </p>
        </Callout>

        {blocking.map((capability) => (
          <Card key={capability.id} title={capability.label} badge={<Pill tone="err">{capability.status}</Pill>}>
            <p>{capability.detail}</p>
            {capability.remedy && <pre>{capability.remedy}</pre>}
          </Card>
        ))}

        <Card title="Quickest fix">
          <p>
            If this is your own checkout, the repository ships a static server that sets both headers:
          </p>
          <pre>npm install{'\n'}npm run preview{'\n'}# then open http://localhost:8080</pre>
          <p className="field-hint">
            &ldquo;Preview&rdquo; runs <code>tools/serve/serve.mjs</code>, which sets{' '}
            <code>Cross-Origin-Opener-Policy: same-origin</code> and{' '}
            <code>Cross-Origin-Embedder-Policy: require-corp</code> and nothing else.
          </p>
        </Card>

        <Card title="What these headers do">
          <p>
            <code>SharedArrayBuffer</code> is only exposed to cross-origin-isolated documents. The
            emulator&apos;s entire memory model depends on it: guest RAM is one shared WASM memory
            read directly by the GPU, audio, and I/O workers. Without sharing, there is no way to avoid
            copying every texture and every audio buffer across a thread boundary.
          </p>
          <pre>{ISOLATION_SNIPPET}</pre>
        </Card>

        <Card title="Browser support">
          <p>
            This build targets Chromium. WebGPU, <code>showDirectoryPicker</code>, and{' '}
            <code>SharedArrayBuffer</code> are all mature there, and Firefox does not yet implement the
            directory picker, which would force the IndexedDB save fallback.
          </p>
        </Card>
      </main>
    </div>
  );
}
