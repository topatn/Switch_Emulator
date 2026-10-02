// web/src/platform/capabilities.ts
//
// Runtime capability detection and the Part 3.9 diagnostics.
//
// The rule from Part 0/Part 7 risk 7: a first-time user must never hit a
// mysterious failure. Every capability this emulator depends on is probed once
// at startup and turned into either a working path or an actionable message.
// The message is the product; the boolean is an implementation detail.

export type CapabilityStatus = 'ok' | 'missing' | 'unsupported';

export interface Capability {
  id: string;
  label: string;
  status: CapabilityStatus;
  detail: string;
  /** What the user should do about it, if anything. */
  remedy?: string;
  /** Blocks the emulator entirely when failing. */
  blocking: boolean;
}

export interface Capabilities {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webAssembly: boolean;
  webGpu: boolean;
  fileSystemAccess: boolean;
  offscreenCanvas: boolean;
  audioWorklet: boolean;
  /** User agent family, used only to phrase hints. */
  browser: 'chromium' | 'firefox' | 'safari' | 'other';
  list: Capability[];
  /** True when nothing blocking is missing. */
  usable: boolean;
}

export const ISOLATION_SNIPPET = `# Your host is missing the headers that enable SharedArrayBuffer.
# Add these to whatever is serving the app (nginx, Caddy, Netlify, ...):

add_header Cross-Origin-Opener-Policy   same-origin  always;
add_header Cross-Origin-Embedder-Policy require-corp always;

# Or, if you have this repo checked out:
#   npm run preview
# which serves on http://localhost:8080 with both headers set.`;

function detectBrowser(): Capabilities['browser'] {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'chromium';
  if (/Chrome\/|Chromium\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/**
 * Probes every platform capability the emulator depends on.
 *
 * Note on ordering: `crossOriginIsolated` is checked first and, when false,
 * the SharedArrayBuffer result is reported as a consequence rather than an
 * independent failure. Users act on one diagnosis, not two.
 */
export async function detectCapabilities(): Promise<Capabilities> {
  const browser = detectBrowser();

  const crossOriginIsolated = typeof globalThis.crossOriginIsolated === 'boolean'
    ? globalThis.crossOriginIsolated
    : false;

  const sabCtor = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
  const hasSabCtor = typeof sabCtor === 'function';
  const sharedArrayBuffer = hasSabCtor && crossOriginIsolated;

  const webAssembly = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';

  const webGpu = 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;

  const fileSystemAccess =
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

  const offscreenCanvas =
    typeof OffscreenCanvas === 'function' &&
    typeof (globalThis as { HTMLCanvasElement?: { prototype?: object } }).HTMLCanvasElement === 'function';

  const audioWorklet =
    typeof AudioWorkletNode === 'function' && typeof AudioContext === 'function';

  const list: Capability[] = [];

  list.push(
    crossOriginIsolated
      ? {
          id: 'coi',
          label: 'Cross-origin isolation',
          status: 'ok',
          detail: 'COOP/COEP headers present; SharedArrayBuffer is available.',
          blocking: true,
        }
      : {
          id: 'coi',
          label: 'Cross-origin isolation',
          status: 'missing',
          detail:
            'crossOriginIsolated is false, so SharedArrayBuffer is unavailable and the shared WASM memory cannot exist.',
          remedy: ISOLATION_SNIPPET,
          blocking: true,
        },
  );

  list.push(
    hasSabCtor
      ? sharedArrayBuffer
        ? {
            id: 'sab',
            label: 'SharedArrayBuffer',
            status: 'ok',
            detail: 'Guest RAM can be shared across workers.',
            blocking: true,
          }
        : {
            id: 'sab',
            label: 'SharedArrayBuffer',
            status: 'missing',
            detail: 'The constructor exists but is gated behind cross-origin isolation.',
            remedy: 'Fix the COOP/COEP headers above; this resolves itself.',
            blocking: true,
          }
      : {
          id: 'sab',
          label: 'SharedArrayBuffer',
          status: 'missing',
          detail: 'This browser does not implement SharedArrayBuffer.',
          remedy: 'Use a current Chromium-based browser.',
          blocking: true,
        },
  );

  list.push(
    webAssembly
      ? { id: 'wasm', label: 'WebAssembly', status: 'ok', detail: 'Runtime available.', blocking: true }
      : {
          id: 'wasm',
          label: 'WebAssembly',
          status: 'missing',
          detail: 'WebAssembly is unavailable, so the emulation core cannot run at all.',
          blocking: true,
        },
  );

  list.push(
    webGpu
      ? {
          id: 'webgpu',
          label: 'WebGPU',
          status: 'ok',
          detail: 'Adapter request will be made by the GPU worker at boot.',
          remedy: undefined,
          blocking: false,
        }
      : {
          id: 'webgpu',
          label: 'WebGPU',
          status: 'missing',
          detail:
            'No WebGPU adapter. The GPU worker cannot present frames, so no title can be rendered.',
          remedy:
            browser === 'firefox'
              ? 'WebGPU support in Firefox is still rolling out. Use Chrome or Edge for now.'
              : 'Check chrome://gpu, or enable chrome://flags/#enable-unsafe-webgpu.',
          blocking: true,
        },
  );

  list.push(
    fileSystemAccess
      ? {
          id: 'fsa',
          label: 'File System Access',
          status: 'ok',
          detail: 'Saves and caches will live in a folder you choose.',
          blocking: false,
        }
      : {
          id: 'fsa',
          label: 'File System Access',
          status: 'unsupported',
          detail:
            'showDirectoryPicker is unavailable. Saves will fall back to IndexedDB, which is opaque, quota-limited, and hard to back up.',
          remedy:
            browser === 'firefox'
              ? 'Firefox does not implement showDirectoryPicker. Chromium keeps your saves in a real folder you own.'
              : 'Provide export/import of save files so nothing is trapped in browser storage.',
          blocking: false,
        },
  );

  list.push(
    offscreenCanvas
      ? {
          id: 'offscreen',
          label: 'OffscreenCanvas',
          status: 'ok',
          detail: 'The GPU worker can render off the main thread.',
          blocking: true,
        }
      : {
          id: 'offscreen',
          label: 'OffscreenCanvas',
          status: 'missing',
          detail: 'Presentation would have to happen on the main thread, which stalls the shell.',
          remedy: 'Use a current Chromium-based browser.',
          blocking: true,
        },
  );

  list.push(
    audioWorklet
      ? { id: 'audio', label: 'AudioWorklet', status: 'ok', detail: '48 kHz mix path available.', blocking: false }
      : {
          id: 'audio',
          label: 'AudioWorklet',
          status: 'missing',
          detail: 'Audio output would fall back to ScriptProcessor, which janks under load.',
          remedy: 'Use a current Chromium-based browser.',
          blocking: false,
        },
  );

  return {
    crossOriginIsolated,
    sharedArrayBuffer,
    webAssembly,
    webGpu,
    fileSystemAccess,
    offscreenCanvas,
    audioWorklet,
    browser,
    list,
    usable: list.every((c) => !c.blocking || c.status === 'ok'),
  };
}
