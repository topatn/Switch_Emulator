// web/src/ui/Saves/SavesScreen.tsx
//
// Part 3.10's saves and save states screen.
//
// The screen that carries the project's most consequential rule. Part 3.8 forbids
// localStorage and IndexedDB-as-primary; Part 3.11 names save corruption as "the
// most user-visible failure we can have". So this screen leads with *where the
// data actually is* and whether it is durable, rather than listing slots.
//
// At Phase 0 there are no saves, because no title mounts. Saying that plainly is
// more useful than an empty table with working-looking buttons.

import { useCallback, useEffect, useState } from 'react';
import { Card, Pill } from '../components';
import { EmulatorPaths, SAVE_VOLUMES } from '../../platform/paths';
import type { Capabilities } from '../../platform/capabilities';

interface SaveEntry {
  /** Path segments, relative to the user folder. */
  path: string[];
  sizeBytes: number;
  modifiedMs: number;
}

interface SavesScreenProps {
  folderName: string | null;
  capabilities: Capabilities | null;
  titles: Array<{ titleId: string; name: string }>;
}

export function SavesScreen({ folderName, capabilities, titles }: SavesScreenProps) {
  const [saves, setSaves] = useState<SaveEntry[] | null>(null);
  const [states, setStates] = useState<SaveEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const usingFallback = capabilities !== null && !capabilities.fileSystemAccess;

  const refresh = useCallback(async () => {
    if (!folderName) {
      setSaves(null);
      setStates(null);
      return;
    }
    setBusy(true);
    try {
      const { loadDirectoryHandle } = await import('../../platform/folderHandle');
      const { FolderStore } = await import('../../platform/storage');
      const handle = await loadDirectoryHandle();
      if (!handle) {
        setSaves(null);
        setStates(null);
        return;
      }
      const store = await FolderStore.open(handle);

      const readDir = async (root: string): Promise<SaveEntry[]> => {
        const titleDirs = await store.list([root]);
        const out: SaveEntry[] = [];
        for (const titleDir of titleDirs) {
          const volumes = await store.list([root, titleDir]);
          for (const volume of volumes) {
            if (volume.endsWith('.tmp')) continue; // an interrupted write
            const size = await store.size([root, titleDir, volume]);
            out.push({ path: [root, titleDir, volume], sizeBytes: size, modifiedMs: 0 });
          }
        }
        return out;
      };

      setSaves(await readDir('saves'));
      setStates(await readDir('states'));
    } catch {
      setSaves(null);
      setStates(null);
    } finally {
      setBusy(false);
    }
  }, [folderName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <h2>Saves and states</h2>
      <p className="lede">
        Save data lives in a folder you own, so you can back it up, move it between machines, and
        delete it. Every write is temp-then-rename, so a crash cannot leave a half-written save.
      </p>

      <Card
        title="Storage location"
        badge={
          usingFallback ? (
            <Pill tone="warn">browser storage</Pill>
          ) : folderName ? (
            <Pill tone="ok">your folder</Pill>
          ) : (
            <Pill tone="muted">no folder</Pill>
          )
        }
      >
        {!folderName ? (
          <p className="muted">No user folder is selected, so there is nowhere to read or write saves.</p>
        ) : usingFallback ? (
          <div className="callout callout-warn">
            <div className="callout-title">This browser is on the IndexedDB fallback</div>
            <div className="callout-body">
              <p>
                Saves are stored in browser storage, which is quota-limited and trapped in this
                browser profile. It survives a reload, but clearing site data destroys it and you
                cannot easily find the file to back it up.
              </p>
              <p>
                Export and import keep this from being a trap: nothing is only reachable from here.
                Chromium avoids this entirely by keeping saves in your chosen folder.
              </p>
            </div>
          </div>
        ) : (
          <table>
            <tbody>
              <tr>
                <td className="muted">Folder</td>
                <td className="num">{folderName}</td>
              </tr>
              <tr>
                <td className="muted">Save volumes</td>
                <td className="num">{EmulatorPaths.saves}/{SAVE_VOLUMES.join(', ')}</td>
              </tr>
              <tr>
                <td className="muted">Save states</td>
                <td className="num">{EmulatorPaths.states}/&lt;titleId&gt;/slot0.state</td>
              </tr>
              <tr>
                <td className="muted">Write method</td>
                <td className="num">temp file, then atomic rename</td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Save data" badge={<Pill tone="muted">{saves?.length ?? 0} volumes</Pill>}>
        {!folderName ? (
          <p className="muted">Select a folder to see saves.</p>
        ) : saves === null ? (
          <p className="muted">Could not read the saves directory.</p>
        ) : saves.length === 0 ? (
          <>
            <p className="muted">No save data yet.</p>
            <div className="callout callout-info">
              <div className="callout-title">Saves appear once a title can mount</div>
              <div className="callout-body">
                <p>
                  Titles are not scanned or mounted in this build, so no game has had the opportunity to
                  write a save. The directory exists and is writable.
                </p>
              </div>
            </div>
          </>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Volume</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {saves.map((entry) => (
                <tr key={entry.path.join('/')}>
                  <td className="compat-title">{titles.find((t) => entry.path[1] === t.titleId)?.name ?? entry.path[1]}</td>
                  <td className="compat-title">{entry.path[2]}</td>
                  <td className="num">{formatBytes(entry.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => void refresh()} disabled={!folderName || busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </Card>

      <Card title="Save states" badge={<Pill tone="muted">{states?.length ?? 0} states</Pill>}>
        {!folderName ? (
          <p className="muted">Select a folder to see save states.</p>
        ) : states === null ? (
          <p className="muted">Could not read the states directory.</p>
        ) : states.length === 0 ? (
          <p className="muted">
            No save states. Taking a state requires a running session, which requires a mounted title.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Slot</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {states.map((entry) => (
                <tr key={entry.path.join('/')}>
                  <td className="compat-title">{titles.find((t) => entry.path[1] === t.titleId)?.name ?? entry.path[1]}</td>
                  <td className="compat-title">{entry.path[2]}</td>
                  <td className="num">{formatBytes(entry.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Export and import" badge={<Pill tone="muted">fallback path only</Pill>}>
        <p>
          On the folder path, saves are already ordinary files you can copy. On the IndexedDB fallback
          this is how you keep them: export to a file, keep that file somewhere safe, and import it on
          another machine or browser.
        </p>
        <div className="btn-row">
          <button className="btn" disabled>
            Export all saves (nothing to export)
          </button>
          <button className="btn" disabled>
            Import saves
          </button>
        </div>
      </Card>
    </>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return 'empty';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 ** 2).toFixed(1)} MiB`;
}
