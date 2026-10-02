// web/src/core/coreUrl.ts
//
// Where the WASM core lives, and how to tell the user which build they have.
//
// Part 3.9's deployment rule ("a boot-time check ... that shows a clear
// diagnostic") applies to the module too: a user running a stale cached core must
// be told which build they have and whether it is the stub.

/** Directory containing core.wasm (and core.js for an Emscripten build). */
export const coreBaseUrl = normalizeBase(import.meta.env.BASE_URL ?? '/');

function normalizeBase(base: string): string {
  // Vite's base is './' for a portable build and '/app/' for a subpath deploy.
  // Trim to a directory with a trailing slash so `${base}core.wasm` is valid.
  if (base === '' || base === './') return './';
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * True when running against the hand-encoded stub core rather than a real
 * Emscripten build.
 *
 * The stub exists so the Phase 0 plumbing (worker boot, ABI handshake, SAB
 * region mapping, latency gate) is verifiable on a machine with no Emscripten
 * toolchain. It emulates nothing. Saying so in the UI is essential — a user who
 * thinks a real core loaded would be misled.
 */
export function isStubBuild(buildId: string): boolean {
  return buildId.toLowerCase().includes('stub');
}

/**
 * A one-line note shown when the stub is in use. Empty string when a real core is
 * loaded, so the UI stays quiet in the normal case.
 */
export const CORE_BUILD_NOTE =
  'Running the hand-encoded stub core (no Emscripten toolchain detected). The ABI, worker ' +
  'topology, shared memory, and audio path are real; no emulation is implemented yet. Build the ' +
  'real core with: emcmake cmake -S core -B core/build -DSW_BUILD_WASM=ON && cmake --build core/build';
