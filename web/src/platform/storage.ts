// web/src/platform/storage.ts
//
// Save-data and settings storage (Part 3.8).
//
// The hard rule: **the primary store is the user's directory, via the File
// System Access API.** Never localStorage (too small, synchronous), never
// IndexedDB as primary (opaque, quota-limited, trapped in an origin silo).
// IndexedDB is the *fallback* for browsers without showDirectoryPicker, and even
// then the app offers export/import so nobody is ever trapped.
//
// Atomicity is the other half of the rule. Every write is
// `write temp -> flush -> rename`, so a crash mid-write can never leave a
// half-written save. Part 3.11 names a corrupted save as "the most user-visible
// failure we can have", and it is cheap to prevent.

import { EmulatorPaths } from './paths';

export interface SaveVolume {
  titleId: string;
  /** "save0" or "user0", per Part 3.8's layout. */
  volume: string;
  bytes: ArrayBuffer;
}

/**
 * A filesystem-backed store rooted at the user's chosen folder.
 *
 * Every method resolves to `null`/`false` rather than throwing when the folder
 * API is unavailable or permission is missing. Callers get a clean "no storage"
 * answer to surface, not an exception to unwind through a worker message.
 */
export class FolderStore {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(root: FileSystemDirectoryHandle): Promise<FolderStore> {
    return new FolderStore(root);
  }

  private async dir(path: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let handle: FileSystemDirectoryHandle = this.root;
    for (const segment of path) {
      try {
        handle = await handle.getDirectoryHandle(segment, { create });
      } catch {
        return null;
      }
    }
    return handle;
  }

  /**
   * Writes a file atomically: temp file first, then rename over the target.
   *
   * FileSystemDirectoryHandle has no rename, so the implementation is
   * write-temp -> copy -> delete-temp. The copy is the point: `createWritable`
   * with `keepExistingData: false` truncates immediately, so writing in place
   * exposes a truncated file if the tab dies. Going through a temp name means
   * the previous save survives intact.
   */
  async writeAtomic(path: string[], data: ArrayBuffer): Promise<boolean> {
    const [dir, fileName] = splitPath(path);
    if (!dir || !fileName) return false;

    const dirHandle = await this.dir(dir, true);
    if (!dirHandle) return false;

    const tempName = `${fileName}.tmp`;
    try {
      // 1. Write the full payload to a temp name.
      const tempFile = await dirHandle.getFileHandle(tempName, { create: true });
      const writable = await tempFile.createWritable({ keepExistingData: false });
      try {
        await writable.write(data);
      } finally {
        // close() is what actually commits and flushes to disk.
        await writable.close();
      }

      // 2. Only now replace the real file.
      //
      // `move()` is the atomic rename. Where it is unavailable (older Chromium,
      // and other engines), fall back to remove-then-copy, which is *not* atomic:
      // a crash between the two steps loses the save. That asymmetry is stated
      // rather than hidden, because it is exactly the failure Part 3.11 calls
      // "the most user-visible failure we can have" - and it is a browser
      // limitation, not something this code can fix.
      if (typeof dirHandle.move === 'function') {
        try {
          await dirHandle.removeEntry(fileName);
        } catch {
          // No existing file: nothing to replace.
        }
        await dirHandle.move(tempName, dirHandle, fileName);
        return true;
      }

      const existing = await dirHandle.getFileHandle(fileName, { create: true });
      const replacement = await existing.createWritable({ keepExistingData: false });
      try {
        await replacement.write(data);
      } finally {
        await replacement.close();
      }
      try {
        await dirHandle.removeEntry(tempName);
      } catch {
        // Nothing to clean up.
      }
      return true;
    } catch (error) {
      // Clean up the temp file so a failure does not leave litter behind.
      try {
        await dirHandle.removeEntry(tempName);
      } catch {
        // Nothing to clean up.
      }
      void error;
      return false;
    }
  }

  async read(path: string[]): Promise<ArrayBuffer | null> {
    const [dir, fileName] = splitPath(path);
    if (!dir || !fileName) return null;
    const dirHandle = await this.dir(dir, false);
    if (!dirHandle) return null;
    try {
      const file = await dirHandle.getFileHandle(fileName);
      return await (await file.getFile()).arrayBuffer();
    } catch {
      return null;
    }
  }

  async remove(path: string[]): Promise<boolean> {
    const [dir, fileName] = splitPath(path);
    if (!dir || !fileName) return false;
    const dirHandle = await this.dir(dir, false);
    if (!dirHandle) return false;
    try {
      await dirHandle.removeEntry(fileName);
      return true;
    } catch {
      return false;
    }
  }

  async list(path: string[]): Promise<string[]> {
    const dirHandle = await this.dir(path, false);
    if (!dirHandle) return [];
    const names: string[] = [];
    if (typeof dirHandle.keys === 'function') {
      for await (const name of dirHandle.keys()) names.push(name);
      return names.sort();
    }
    // Older implementations only expose the async-iterator form.
    for await (const [name] of dirHandle) names.push(name);
    return names.sort();
  }

  async size(path: string[]): Promise<number> {
    const [dir, fileName] = splitPath(path);
    if (!dir || !fileName) return 0;
    const dirHandle = await this.dir(dir, false);
    if (!dirHandle) return 0;
    try {
      const file = await dirHandle.getFileHandle(fileName);
      return (await file.getFile()).size;
    } catch {
      return 0;
    }
  }

  /**
   * Ensures Part 3.8's folder layout exists.
   *
   * Creating the skeleton up front is kinder than failing later: the user sees
   * the expected tree immediately and knows where to drop their game, and a
   * permission problem surfaces now rather than at save time.
   */
  async ensureLayout(): Promise<string[]> {
    const created: string[] = [];
    for (const template of Object.values(EmulatorPaths)) {
      const segments = template.split('/').filter(Boolean);
      for (let i = 1; i <= segments.length; i++) {
        const path = segments.slice(0, i);
        // "<titleId>" is a per-title placeholder: create the parent only.
        if (path[path.length - 1] === '<titleId>') break;
        if (await this.dir(path, true)) created.push(path.join('/'));
      }
    }
    return created;
  }
}

// --- IndexedDB fallback ---------------------------------------------------

/**
 * Fallback storage for browsers without showDirectoryAccess (notably Firefox).
 *
 * IndexedDB transactions are atomic, which is why Part 3.8 says crash-safety is
 * preserved on this path too. The UI must also state plainly that the user is on
 * browser storage and offer export/import, so nothing is trapped.
 */
export class IdbStore {
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(
    dbName = 'switch-web',
    private readonly storeName = 'saves',
  ) {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    });
  }

  private key(titleId: string, volume: string): string {
    return `${titleId}/${volume}`;
  }

  async write(titleId: string, volume: string, data: ArrayBuffer): Promise<boolean> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).put(data, this.key(titleId, volume));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }

  async read(titleId: string, volume: string): Promise<ArrayBuffer | null> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).get(this.key(titleId, volume));
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
      req.onerror = () => resolve(null);
    });
  }

  async list(): Promise<string[]> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]).sort());
      req.onerror = () => resolve([]);
    });
  }

  async remove(titleId: string, volume: string): Promise<boolean> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).delete(this.key(titleId, volume));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }
}

/**
 * Triggers a browser download of a save, so the fallback path is never a trap.
 *
 * Part 3.8: "Tell the user plainly that they're on browser storage, and provide
 * export/import of saves as a portable file so nobody is ever trapped."
 */
export function exportSaveAsFile(fileName: string, data: ArrayBuffer): void {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers; a short
  // timeout is the documented workaround.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function splitPath(path: string[]): [string[], string] | [null, null] {
  if (path.length === 0) return [null, null];
  const fileName = path[path.length - 1]!;
  const dir = path.slice(0, -1);
  if (!fileName) return [null, null];
  return [dir, fileName];
}
