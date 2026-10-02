// web/src/workers/io.worker.ts
//
// I/O worker (Part 3.8/3.9). Phase 0 scope: prove the folder-picker and
// keys-picker flows work end to end, with no game content involved.
//
// This is the worker that owns Part 3.8's hard rule: save data is written to a
// user-chosen local folder via the File System Access API, never localStorage
// and never IndexedDB as the primary store. Getting that right in Phase 0
// matters because the fallback decision is architectural (Part 8.3, risk 3 in
// Part 7) rather than a detail that can be retrofitted.
//
// What is implemented:
//   - directory handle persistence (IndexedDB, which is exactly what it is good
//     at: an opaque, durable, small pointer to a user-granted resource)
//   - a read-only directory probe that proves the handle survived a reload
//   - the prod.keys picker, which validates the *shape* of a key file without
//     ever logging, displaying, or storing key material (Part 0)
//
// What is not implemented (Phase 1/2): RomFS block reading, save writes,
// save-state serialisation, atomic temp+rename.

import { bootWorker, installCommonHandlers, reportError, log, type WorkerContext } from './common';
import { WorkerKind } from '../platform/protocol';
import type { WorkerRequest, ProbeFolderRequest, RestoreFolderRequest, PickKeysRequest } from '../platform/protocol';

const ctx: WorkerContext = { kind: WorkerKind.Io };

// --- Directory handle persistence -----------------------------------------

const DB_NAME = 'switch-web';
const DB_VERSION = 1;
const HANDLE_STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

// Handle persistence lives on the main thread in web/src/platform/folderHandle.ts,
// not here. The picker is a user gesture, which a worker cannot host, and having
// one implementation of "where the handle is stored" avoids two of them drifting.
/**
 * Reads the current permission for a directory handle.
 *
 * `queryPermission` is absent on older implementations and on handles from a
 * previous session, so 'prompt' is the honest fallback: it means "we do not
 * currently have access", which is exactly what the UI needs to decide between
 * "pick a folder" and "re-grant access".
 */
async function queryPermission(handle: FileSystemDirectoryHandle): Promise<FileSystemPermissionState> {
  if (typeof handle.queryPermission !== 'function') return 'prompt';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const req = tx.objectStore(HANDLE_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error('idb get failed'));
  });
  db.close();
  return result;
}

// --- folder layout (Part 3.8) ---------------------------------------------

/**
 * The expected user-folder layout. Exported so the UI can render the tree and
 * tell the user exactly what to create, rather than just "pick a folder".
 */
export const FOLDER_LAYOUT = [
  { path: 'games/', purpose: 'Your own legally-dumped XCI / NSP / NCA / NSO files.' },
  { path: 'keys/prod.keys', purpose: 'Your own keys file. Never uploaded, never displayed.' },
  { path: 'firmware/', purpose: 'Optional. Not required by the Model A HLE boot path.' },
  { path: 'saves/<titleId>/', purpose: 'Per-title save data. Written atomically.' },
  { path: 'states/<titleId>/', purpose: 'Save states.' },
  { path: 'cache/shaders/<titleId>/', purpose: 'Translated WGSL + driver pipeline binaries.' },
  { path: 'cache/code/<titleId>/', purpose: 'JIT blocks + profile counters.' },
  { path: 'cheats/  mods/', purpose: 'Optional per-title settings files (data, not code).' },
] as const;

interface DirectorySummary {
  name: string;
  writable: boolean;
  entries: Array<{ name: string; kind: 'file' | 'directory' }>;
  present: Array<string>;
  missing: string[];
}

async function summariseDirectory(handle: FileSystemDirectoryHandle): Promise<DirectorySummary> {
  const entries: DirectorySummary['entries'] = [];
  // A bounded scan: we are proving the handle works, not mirroring the tree.
  // Scanning a 14 GB install here would be both slow and pointless.
  if (typeof handle.entries === 'function') {
    for await (const [name, entry] of handle.entries()) {
      entries.push({ name, kind: entry.kind });
      if (entries.length >= 32) break;
    }
  }

  const present: string[] = [];
  const missing: string[] = [];
  for (const item of FOLDER_LAYOUT) {
    const first = item.path.split('/')[0]!;
    const exists = entries.some((e) => e.name === first);
    (exists ? present : missing).push(first);
  }

  return { name: handle.name, writable: true, entries, present, missing };
}

// --- keys file handling (Part 0) -----------------------------------------

/**
 * Validates the *shape* of a prod.keys file.
 *
 * This function deliberately does not retain, return, or log any key value. It
 * reports only counts and the presence of key names, because Part 0 requires
 * that key material is never displayed or logged, and "we only log the first
 * line to debug" is how that rule gets broken.
 */
interface KeysSummary {
  valid: boolean;
  /** Total `name = hexvalue` lines seen. */
  lineCount: number;
  /** Lines whose value parsed as 32 hex chars (a 128-bit key). */
  keyLineCount: number;
  /** Names of the key families present, e.g. master_key_00, titlekey. Never values. */
  families: string[];
  /** Rights-ids present; used later for the Part 0 rights check. */
  rightsIdCount: number;
  problems: string[];
}

function summariseKeys(text: string): KeysSummary {
  const problems: string[] = [];
  const families = new Set<string>();
  let lineCount = 0;
  let keyLineCount = 0;
  let rightsIdCount = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) {
      problems.push(`line ${lineCount + 1}: not a name = value pair`);
      continue;
    }
    lineCount++;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    // rights_id entries are 32 hex chars but are ids, not keys.
    if (name.startsWith('rights_id')) {
      if (/^[0-9a-f]{32}$/i.test(value)) rightsIdCount++;
      continue;
    }

    if (/^[0-9a-f]{32}$/i.test(value)) {
      keyLineCount++;
      // Family = name with trailing digits and known suffixes collapsed.
      families.add(name.replace(/[0-9]+$/, '#'));
    } else {
      problems.push(`line ${lineCount + 1}: "${name}" does not have a 32-character hex value`);
    }
  }

  const valid = keyLineCount > 0 && problems.length === 0;
  if (keyLineCount === 0) problems.push('No 128-bit key entries were found.');
  if (rightsIdCount === 0) {
    problems.push(
      'No rights_id entries. Titles whose rights_id is absent will be refused, matching hardware behaviour (Part 0).',
    );
  }

  return { valid, lineCount, keyLineCount, families: [...families].sort(), rightsIdCount, problems };
}

// --- request handlers -----------------------------------------------------

type HandlerMap = Partial<Record<WorkerRequest['type'], (msg: never) => Promise<void> | void>>;

installCommonHandlers(ctx, {
  'probe-folder': async (raw: ProbeFolderRequest) => {
    const handle = await idbGet<FileSystemDirectoryHandle>('userFolder');
    if (!handle) {
      post({ type: 'log', kind: WorkerKind.Io, level: 'info', message: 'No user folder has been granted yet.' });
      return;
    }
    // A persisted handle can lose permission after a reload; query() is the
    // documented check and reports a state rather than throwing.
    const permission = await queryPermission(handle);
    const summary = await summariseDirectory(handle);
    post({
      type: 'folder-summary',
      seq: raw.seq,
      name: handle.name,
      permission,
      entries: summary.entries,
      present: summary.present,
      missing: summary.missing,
    });
    post({
      type: 'log',
      kind: WorkerKind.Io,
      level: 'info',
      message:
        `User folder "${summary.name}" restored (permission: ${permission}). ` +
        `Top-level entries: ${summary.entries.map((e) => e.name).join(', ') || '(empty)'}.`,
    });
  },

  'restore-folder': async (raw: RestoreFolderRequest) => {
    void raw;
    const handle = await idbGet<FileSystemDirectoryHandle>('userFolder');
    if (!handle) return;
    const state = await queryPermission(handle);
    if (state === 'granted') {
      log(WorkerKind.Io, 'info', `Access to "${handle.name}" is still granted.`);
    } else {
      log(
        WorkerKind.Io,
        'warn',
        `Access to "${handle.name}" needs to be re-granted. The picker will re-request it on demand.`,
      );
    }
  },

  'pick-keys': async (raw: PickKeysRequest) => {
    if (typeof showOpenFilePicker !== 'function') {
      post({
        type: 'log',
        kind: WorkerKind.Io,
        level: 'error',
        message:
          'showOpenFilePicker is unavailable in this browser. Provide keys by placing prod.keys at <user folder>/keys/prod.keys.',
      });
      return;
    }

    let picked: FileSystemFileHandle | null = null;
    try {
      const picker = showOpenFilePicker;
      const [handle] = await picker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Switch keys file',
            accept: { 'text/plain': ['.keys'] },
          },
        ],
      });
      picked = handle ?? null;
    } catch (error) {
      // AbortError is the user changing their mind, which is not an error.
      if (error instanceof DOMException && error.name === 'AbortError') {
        post({ type: 'log', kind: WorkerKind.Io, level: 'info', message: 'Key selection cancelled.' });
        return;
      }
      throw error;
    }

    if (!picked) return;

    const file = await picked.getFile();
    const text = await file.text();
    const summary = summariseKeys(text);

    // The File object and its text go out of scope here. We keep neither the
    // handle nor the contents: re-reading the file on demand is the intended
    // flow, and holding key material in a worker global is exactly what Part 0
    // rules out. Only counts and key *names* cross the boundary.
    post({
      type: 'keys-summary',
      seq: raw.seq,
      fileName: file.name,
      byteLength: file.size,
      valid: summary.valid,
      keyLineCount: summary.keyLineCount,
      rightsIdCount: summary.rightsIdCount,
      families: summary.families,
      problems: summary.problems,
    });
    post({
      type: 'log',
      kind: WorkerKind.Io,
      level: summary.valid ? 'info' : 'error',
      message:
        `Keys file "${file.name}" (${file.size} bytes): ${summary.keyLineCount} key entries, ` +
        `${summary.rightsIdCount} rights_ids, families [${summary.families.join(', ')}]. ` +
        `Valid: ${summary.valid}. Key material was not retained or logged.` +
        (summary.problems.length ? ` Issues: ${summary.problems.join(' ')}` : ''),
    });
  },
} satisfies HandlerMap);

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg?.type !== 'boot') return;

  try {
    await bootWorker(WorkerKind.Io, msg);
    // Probing on boot turns "did my folder survive the reload?" into a line in
    // the diagnostics log instead of a support question.
    post({ type: 'probe-folder', seq: 0 } satisfies ProbeFolderRequest);
  } catch (error) {
    reportError(WorkerKind.Io, error);
  }
});
