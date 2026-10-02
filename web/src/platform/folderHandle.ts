// web/src/platform/folderHandle.ts
//
// Persistence for the user-chosen directory handle (Part 3.8).
//
// This module is the *only* place origin storage is written on the primary
// storage path, and it writes exactly one thing: a FileSystemDirectoryHandle.
//
// Part 0 is explicit that saves live in the user's folder and that nothing is
// written outside it. A handle is a capability, not content — it is a pointer
// the browser will only honour after the user grants access again, so storing it
// grants us nothing we were not already given. Storing the save *data* here
// instead would violate Part 0 and is why this module has no other exports.

const DB_NAME = 'switch-web';
const DB_VERSION = 1;
const STORE = 'handles';
const USER_FOLDER_KEY = 'userFolder';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

export async function persistDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, USER_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('persisting the folder handle failed'));
      tx.onabort = () => reject(tx.error ?? new Error('persisting the folder handle aborted'));
    });
  } finally {
    db.close();
  }
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  try {
    const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(USER_FOLDER_KEY);
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      req.onerror = () => reject(req.error ?? new Error('reading the folder handle failed'));
    });
    return handle ?? null;
  } catch {
    // A corrupt or blocked IndexedDB must not prevent the app from starting. The
    // user simply has to pick the folder again.
    return null;
  } finally {
    db.close();
  }
}

export async function forgetDirectoryHandle(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(USER_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('clearing the folder handle failed'));
    });
  } finally {
    db.close();
  }
}

export interface FolderPermission {
  state: FileSystemPermissionState;
  /** True when a stored handle exists but needs the user to re-grant access. */
  needsRegrant: boolean;
}

/**
 * Checks whether a stored handle is still usable.
 *
 * A handle can survive a reload and still be unusable: permission is not
 * persisted. The app must distinguish "never picked a folder" from "picked one,
 * needs re-granting", because the second is a one-click fix and the first needs
 * the whole onboarding flow.
 */
export async function checkFolderPermission(): Promise<FolderPermission | null> {
  const handle = await loadDirectoryHandle();
  if (!handle) return null;

  const query = handle.queryPermission;
  if (typeof query !== 'function') {
    // No permission API at all: treat it as needing a re-grant, which is the
    // conservative answer, and attempt the request below.
    return { state: 'prompt', needsRegrant: true };
  }

  try {
    const state = await query.call(handle, { mode: 'readwrite' });
    if (state === 'granted') return { state, needsRegrant: false };
    // 'prompt' and 'denied' are both "not currently usable". The distinction only
    // matters to the UI copy, and 'prompt' is the one worth retrying, so both
    // report needsRegrant with their own state preserved.
    return { state, needsRegrant: true };
  } catch {
    // Some engines throw on a handle from a previous session.
    return { state: 'denied', needsRegrant: true };
  }
}

/**
 * Requests write access. Must be called from a user gesture.
 *
 * Note the `id` passed to showDirectoryPicker in WorkerHost: reusing a stable id
 * means the browser remembers the user's previous choice, which is the
 * difference between a one-click flow and re-navigating the tree every time.
 */
export async function requestRegrant(): Promise<FileSystemDirectoryHandle | null> {
  const existing = await loadDirectoryHandle();
  if (!existing) return null;

  const request = existing.requestPermission;
  if (typeof request !== 'function') return null;

  try {
    const state = await request.call(existing, { mode: 'readwrite' });
    return state === 'granted' ? existing : null;
  } catch {
    return null;
  }
}
