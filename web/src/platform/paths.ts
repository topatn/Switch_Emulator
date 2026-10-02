// web/src/platform/paths.ts
//
// The user-folder path vocabulary (Part 3.8), in one place.
//
// Everything that needs to know where a save or a cache lives derives it from
// here. A path template appearing in two components is how a save ends up in one
// place and a save-state reader looking in another, and that bug is invisible
// until a user's data is silently missing.

/**
 * Path templates, relative to the user-chosen folder root.
 *
 * These strings are the same ones the I/O worker reports to the user during
 * onboarding, so the tree they are told to create is exactly the tree the code
 * reads.
 */
export const EmulatorPaths = {
  /** User drops their own legally-dumped XCI/NSP/NCA/NSO here. */
  games: 'games',
  /** User-supplied keys. Never uploaded, never displayed. */
  keys: 'keys',
  keysFile: 'keys/prod.keys',
  /** Optional: not required by the Model A HLE boot path (Part 3.4). */
  firmware: 'firmware',
  saves: 'saves/<titleId>',
  states: 'states/<titleId>',
  shaderCache: 'cache/shaders/<titleId>/<translatorVersion>',
  codeCache: 'cache/code/<titleId>',
  cheats: 'cheats',
  mods: 'mods',
} as const;

export type EmulatorPathKey = keyof typeof EmulatorPaths;

/** Replaces the `<titleId>` placeholder with a real title id. */
export function resolvePath(key: EmulatorPathKey, titleId?: string): string {
  const template = EmulatorPaths[key];
  return titleId ? template.replace('<titleId>', titleId) : template;
}

/** Splits a slash path into the segment array the File System Access API wants. */
export function toSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Per-title save volume names, per Part 3.8's layout: `save0` and `user0`. */
export const SAVE_VOLUMES = ['save0', 'user0'] as const;
export type SaveVolumeName = (typeof SAVE_VOLUMES)[number];

/**
 * Content extensions the loader will recognise.
 *
 * Part 3.1 lists the supported set. Having it in one place means the library
 * scanner and the "what can I drop here?" hint cannot disagree.
 */
export const CONTENT_EXTENSIONS = ['.xci', '.nsp', '.nca', '.nso', '.nro'] as const;

export function isContentFile(name: string): boolean {
  const lower = name.toLowerCase();
  return CONTENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * File names that must never appear in the repository or a build artifact.
 *
 * Part 0 requires CI to grep for these as *filenames only* — never as contents.
 * Kept here so the app can warn a user who drops a keys file into `games/`.
 */
export const FORBIDDEN_IN_GAME_DIR = ['prod.keys', 'keys.txt'] as const;
