// web/src/ui/Library/LibraryScreen.tsx
//
// Part 3.10's Library screen.
//
// The honest version of this screen at Phase 0: there are no titles yet, and
// saying so precisely is more useful than a spinner. What it *can* show
// truthfully is the user's folder state, the expected layout, and the fact that
// nothing is scanned yet because mounting is Phase 1.
//
// The status badges are defined now because they encode a real judgement
// (Playable / Boots to title screen / Boots / Not yet supported / Needs keys /
// Needs firmware) that Phase 2 onward will populate. Defining them early makes
// it obvious that "Boots" is not "Playable".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Callout, Card, Pill } from '../components';
import { EmulatorPaths, CONTENT_EXTENSIONS } from '../../platform/paths';
import { ISOLATION_SNIPPET } from '../../platform/capabilities';
import type { AppState, Store } from '../../state/appState';

/** Part 3.10's status badge set. `Playable` is the only fully-good state. */
export const TITLE_STATUSES = [
  'Playable',
  'Boots to title screen',
  'Boots',
  'Not yet supported',
  'Needs keys',
  'Needs firmware',
] as const;
export type TitleStatus = (typeof TITLE_STATUSES)[number];

export function statusTone(status: TitleStatus): 'ok' | 'warn' | 'muted' | 'err' {
  switch (status) {
    case 'Playable':
      return 'ok';
    case 'Boots to title screen':
    case 'Boots':
      return 'warn';
    case 'Needs keys':
    case 'Needs firmware':
      return 'accent' as never;
    default:
      return 'muted';
  }
}

interface LibraryScreenProps {
  state: AppState;
  store: Store;
  onPickFolder: () => void;
  folderBusy: boolean;
}

export function LibraryScreen({ state, onPickFolder, folderBusy }: LibraryScreenProps) {
  const { observation } = state;
  const folderName = observation.userFolderName;

  // The scan count is a real measurement of the games/ directory rather than a
  // placeholder. Even at Phase 0 it is worth having, because it proves the
  // handle is readable and tells the user where to drop a file.
  const [gameFileCount, setGameFileCount] = useState<number | null>(null);

  const scanGames = useCallback(async () => {
    if (!folderName) {
      setGameFileCount(null);
      return;
    }
    try {
      const { loadDirectoryHandle } = await import('../../platform/folderHandle');
      const { FolderStore } = await import('../../platform/storage');
      const handle = await loadDirectoryHandle();
      if (!handle) {
        setGameFileCount(null);
        return;
      }
      const store = await FolderStore.open(handle);
      const entries = await store.list([EmulatorPaths.games]);
      setGameFileCount(entries.filter((name) => CONTENT_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e))).length);
    } catch {
      setGameFileCount(null);
    }
  }, [folderName]);

  useEffect(() => {
    void scanGames();
  }, [scanGames]);

  const summary = useMemo(() => {
    if (!folderName) return 'No user folder selected.';
    if (gameFileCount === null) return `Folder "${folderName}" selected, but it could not be read.`;
    if (gameFileCount === 0) {
      return `Folder "${folderName}" selected. No game files found yet.`;
    }
    return `Folder "${folderName}" contains ${gameFileCount} game file${gameFileCount === 1 ? '' : 's'}.`;
  }, [folderName, gameFileCount]);

  return (
    <>
      <h2>Library</h2>
      <p className="lede">
        switch-web never ships, downloads, or fetches game content. You provide a legally-dumped
        title from your own hardware, and it is read directly from a folder you choose.
      </p>

      <Card
        title="Your folder"
        badge={folderName ? <Pill tone="ok">connected</Pill> : <Pill tone="warn">required</Pill>}
      >
        <p>{summary}</p>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onPickFolder} disabled={folderBusy}>
            {folderBusy ? 'Opening…' : folderName ? 'Choose a different folder' : 'Choose folder'}
          </button>
          {folderName && (
            <button className="btn" onClick={() => void scanGames()}>
              Rescan
            </button>
          )}
        </div>

        {folderName && (
          <>
            <h3>Expected layout</h3>
            <div className="path-tree">
              {EXPECTED_LAYOUT.map((line) => (
                <div key={line.path}>
                  {line.path}
                  <span className="muted" style={{ marginLeft: 12 }}>
                    {line.purpose}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card title="Titles" badge={<Pill tone="muted">0 titles</Pill>}>
        <Callout tone="info" title="Title scanning is not implemented yet">
          <p>
            Part 3.1 (container/NCA parsing and RomFS construction) is Phase 1 work, and Phase 2 adds
            the HLE boot path. Nothing in this build reads a game file.
          </p>
          <p>
            When it does, a dropped file appears here with a status badge. The badges are not
            interchangeable: <strong>Boots</strong> means the title reached a menu and nothing more, and
            only <strong>Playable</strong> means the full loop — menu to overworld to battle to save —
            works end to end.
          </p>
        </Callout>
      </Card>

      {!observation.capabilities?.fileSystemAccess && observation.capabilities !== null && (
        <Callout tone="warn" title="File System Access is unavailable in this browser">
          <p>
            Saves will fall back to IndexedDB, which is opaque, quota-limited, and difficult to back
            up. Chromium keeps your saves in a real folder you own. Firefox does not yet implement{' '}
            <code>showDirectoryPicker</code>.
          </p>
        </Callout>
      )}

      {observation.capabilities && !observation.capabilities.crossOriginIsolated && (
        <Callout tone="err" title="Cross-origin isolation is missing">
          <p>SharedArrayBuffer is unavailable, so no emulation core can start.</p>
          <pre>{ISOLATION_SNIPPET}</pre>
        </Callout>
      )}
    </>
  );
}

/**
 * The Part 3.8 tree the app expects.
 *
 * Deliberately not annotated with what is present on disk: that check belongs to
 * the I/O worker, which is the only context that holds the directory handle, and
 * duplicating it here would mean two implementations of "is this folder set up
 * correctly" drifting apart.
 */
export const EXPECTED_LAYOUT = [
  { path: EmulatorPaths.games + '/', purpose: 'Your own legally-dumped XCI / NSP / NCA / NSO files.' },
  { path: EmulatorPaths.keys + '/', purpose: 'Your own prod.keys. Never uploaded or displayed.' },
  { path: EmulatorPaths.firmware + '/', purpose: 'Optional. Not needed for the HLE boot path.' },
  { path: EmulatorPaths.saves + '/', purpose: 'Per-title save data. Written atomically.' },
  { path: EmulatorPaths.states + '/', purpose: 'Save states.' },
  { path: EmulatorPaths.shaderCache + '/', purpose: 'Translated WGSL + driver pipeline binaries.' },
  { path: EmulatorPaths.codeCache + '/', purpose: 'JIT blocks + profile counters.' },
  {
    path: `${EmulatorPaths.cheats}/  ${EmulatorPaths.mods}/`,
    purpose: 'Optional settings files (data, not code).',
  },
] as const;
