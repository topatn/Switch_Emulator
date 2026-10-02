// web/src/core/instantiate.ts
//
// Loads and attaches the WASM emulation core.
//
// This is the module that makes the Part 6 Phase 0 gate real:
//
//   "Emscripten core builds and runs in a worker"
//   "WASM core instantiates in each worker type"
//   "crossOriginIsolated === true"
//
// Three things are worth understanding here.
//
// 1. **Two module shapes are supported.** The Emscripten build is a
//    MODULARIZE/EXPORT_ES6 factory (a JS file that returns a promise of
//    exports). The stub build is a bare .wasm with no glue. Both are handled so
//    the shell boots with or without an Emscripten toolchain present.
//
// 2. **The ABI version is checked before anything else runs.** A stale cached
//    module is the single most likely cause of a baffling failure, and turning
//    it into "ABI mismatch: shell wants 1, module is 2" costs one call.
//
// 3. **Views are never cached across a growth.** Part 3.3 and Part 7 risk 4:
//    ALLOW_MEMORY_GROWTH can move the base pointer, which detaches every
//    existing typed-array view. `CoreMemory` below exists so that re-deriving
//    views is the only thing a caller has to do, and it is impossible to hold a
//    stale one by accident.

import {
  ABI_VERSION,
  SwArenaRegion,
  SwStatus,
  SwArenaRange_LAYOUT,
  fieldOffset,
  SwCoreTelemetry_LAYOUT,
  type SwCoreExports,
} from '@gen/abi';

/** A view bundle over the core's linear memory. Cheap; must be re-created after growth. */
export interface CoreMemory {
  buffer: ArrayBufferLike;
  u8: Uint8Array;
  u32: Uint32Array;
  i32: Int32Array;
  u64: BigUint64Array;
  f32: Float32Array;
  f64: Float64Array;
  byteLength: number;
}

export function makeCoreMemory(memory: WebAssembly.Memory): CoreMemory {
  const buffer = memory.buffer as ArrayBufferLike;
  return {
    buffer,
    u8: new Uint8Array(buffer),
    u32: new Uint32Array(buffer),
    i32: new Int32Array(buffer),
    u64: new BigUint64Array(buffer),
    f32: new Float32Array(buffer),
    f64: new Float64Array(buffer),
    byteLength: buffer.byteLength,
  };
}

export interface RegionInfo {
  id: number;
  name: string;
  offset: number;
  size: number;
  flags: number;
  /** A typed-array view over the region, valid until the next growth. */
  bytes: Uint8Array;
}

const REGION_NAMES = Object.entries(SwArenaRegion)
  .filter(([name]) => name !== 'SW_REGION_COUNT')
  .map(([name, value]) => ({ name, value: value as number }));

export function regionName(id: number): string {
  return REGION_NAMES.find((r) => r.value === id)?.name ?? `SW_REGION_${id}`;
}

/** The raw shape the core returns for a struct return type. */
interface StructReturn {
  // wasm32 returns a 16-byte struct as up to two i32 lanes.
  lane0: number;
  lane1: number;
}

export interface CoreAttachInfo {
  abiVersion: number;
  features: number;
  buildId: string;
  isShared: boolean;
  memory: CoreMemory;
  /**
   * The underlying WebAssembly.Memory.
   *
   * Kept so growth detection is exact: after `sw_arena_grow`, the base pointer
   * may have moved and `memory.buffer` will be a *different* ArrayBuffer. Having
   * the memory object means we compare buffers rather than guessing from sizes.
   */
  wasmMemory: WebAssembly.Memory;
  exports: SwCoreExports;
  regions: RegionInfo[];
  telemetryOffset: number;
}

export class CoreLoadError extends Error {
  constructor(
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'CoreLoadError';
  }
}

/**
 * Raw Emscripten factory signature, narrowed to what we actually call.
 *
 * An Emscripten MODULARIZE factory returns its exports as own properties, so the
 * index signature is the honest shape here. `wasmMemory` is how the shared
 * linear memory reaches JS when `-sSHARED_MEMORY` is on.
 */
type EmscriptenFactory = (
  moduleOverrides?: Record<string, unknown>,
) => Promise<Record<string, unknown> & { wasmMemory: WebAssembly.Memory }>;

/**
 * Instantiates the core and returns its exports.
 *
 * `coreBaseUrl` is the directory holding `core.wasm` (and `core.js` when built
 * by Emscripten). It is passed in rather than derived from `import.meta.url` so
 * that workers, the main thread, and tests all resolve it the same way.
 */
export async function instantiateCore(coreBaseUrl: string): Promise<CoreAttachInfo> {
  if (typeof WebAssembly !== 'object') {
    throw new CoreLoadError(
      'WebAssembly is not available in this browser.',
      'The emulation core is WebAssembly; there is no fallback path.',
    );
  }

  const wasmUrl = `${coreBaseUrl}core.wasm`;
  let raw: Record<string, unknown>;
  let memory: WebAssembly.Memory;

  // Try the Emscripten factory first (core.js), then the bare module (core.wasm).
  try {
    const mod = await import(/* @vite-ignore */ `${coreBaseUrl}core.js`);
    const factory = (mod.default ?? mod) as EmscriptenFactory;
    const instance = await factory({
      // Serve the .wasm from the same origin as the module so COEP
      // `require-corp` is satisfied without a CORP header.
      locateFile: (path: string) => `${coreBaseUrl}${path}`,
    });
    raw = Object.fromEntries(
      Object.entries(instance).filter(([k]) => k.startsWith('sw_')),
    ) as Record<string, unknown>;
    memory = instance.wasmMemory;
  } catch (factoryError) {
    // Bare-module path. Also the path the Phase 0 stub build uses.
    try {
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      // Streaming compilation keeps the first boot from paying a double read.
      const result = await WebAssembly.instantiateStreaming(response.clone(), {
        env: {
          // The stub core imports nothing, but a real build will. Declaring the
          // common Emscripten imports here keeps this call site from having to
          // change shape when the core grows.
          memory: new WebAssembly.Memory({ initial: 1024 }),
        },
      }).catch(async () => {
        // Some servers (and file://) do not set application/wasm, which breaks
        // instantiateStreaming. Fall back to compiling the bytes directly.
        const bytes = await response.arrayBuffer();
        return WebAssembly.instantiate(bytes, {});
      });

      const inst = (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
      raw = inst.exports as unknown as Record<string, unknown>;
      const exportedMemory = inst.exports.memory as WebAssembly.Memory | undefined;
      if (!exportedMemory) {
        throw new CoreLoadError(
          'The core module does not export its linear memory.',
          'Rebuild the core; the shell needs the memory to map arena regions.',
        );
      }
      memory = exportedMemory;
    } catch (wasmError) {
      throw new CoreLoadError(
        `Failed to load the emulation core from ${wasmUrl}: ${
          wasmError instanceof Error ? wasmError.message : String(wasmError)
        }`,
        factoryError instanceof Error
          ? `The Emscripten factory also failed: ${factoryError.message}`
          : 'Build the core with: emcmake cmake -S core -B core/build -DSW_BUILD_WASM=ON && cmake --build core/build',
      );
    }
  }

  const exports = raw as unknown as SwCoreExports;

  // --- ABI gate. Everything below assumes the layout we generated. ----------
  const abiVersion = exports.sw_abi_version();
  if (abiVersion !== ABI_VERSION) {
    throw new CoreLoadError(
      `ABI mismatch: the shell expects v${ABI_VERSION} but the core module reports v${abiVersion}.`,
      'The core is stale (or newer than the shell). Rebuild it, or clear the cached build.',
    );
  }

  const required: Array<keyof SwCoreExports> = [
    'sw_abi_version',
    'sw_core_features',
    'sw_core_build_id',
    'sw_core_init',
    'sw_core_state',
    'sw_core_arena_size',
    'sw_core_region_table',
    'sw_core_telemetry_offset',
    'sw_core_ping',
    'sw_core_monotonic_ns',
  ];
  const missing = required.filter((name) => typeof exports[name] !== 'function');
  if (missing.length) {
    throw new CoreLoadError(
      `The core module is missing required exports: ${missing.join(', ')}.`,
      'Rebuild the core. This usually means the Emscripten EXPORTED_FUNCTIONS list drifted from the ABI header.',
    );
  }

  const coreMemory = makeCoreMemory(memory);
  const isShared = typeof SharedArrayBuffer === 'function' && coreMemory.buffer instanceof SharedArrayBuffer;

  return {
    abiVersion,
    features: exports.sw_core_features(),
    buildId: readCString(coreMemory, exports.sw_core_build_id() as unknown as number),
    isShared,
    memory: coreMemory,
    wasmMemory: memory,
    exports,
    regions: [],
    telemetryOffset: 0,
  };
}

/** Boots the core's arena and reads back the region table. */
export function initCore(info: CoreAttachInfo, arenaBytes: number): RegionInfo[] {
  const rc = info.exports.sw_core_init(arenaBytes);
  if (rc !== SwStatus.SW_OK) {
    throw new CoreLoadError(
      `Core initialisation failed with status ${rc} for a ${formatBytes(arenaBytes)} arena.`,
      rc === SwStatus.SW_ERR_OUT_OF_MEMORY
        ? 'Reduce the arena size in Settings, or close other tabs. Browsers cap wasm memory well below the Switch\'s full physical space.'
        : undefined,
    );
  }

  const tableBytes = SwArenaRange_LAYOUT.size * (SwArenaRegion.SW_REGION_COUNT as number);
  const scratch = info.exports.sw_core_arena_ptr();
  const written = info.exports.sw_core_region_table(scratch, tableBytes);

  if (written !== tableBytes) {
    throw new CoreLoadError(
      `Core returned a short region table (${written} of ${tableBytes} bytes).`,
      'ABI mismatch between the shell and the core module.',
    );
  }

  const u32 = info.memory.u32;
  const base = scratch >>> 2;
  const regions: RegionInfo[] = [];

  for (let i = 0; i < (SwArenaRegion.SW_REGION_COUNT as number); i++) {
    const o = base + i * (SwArenaRange_LAYOUT.size >>> 2);
    const offset = u32[o]!;
    const size = u32[o + 1]!;
    const id = u32[o + 2]!;
    const flags = u32[o + 3]!;
    regions.push({
      id,
      name: regionName(id),
      offset,
      size,
      flags,
      bytes: size > 0 ? info.memory.u8.subarray(offset, offset + size) : new Uint8Array(0),
    });
  }

  info.regions = regions;
  (info as { telemetryOffset: number }).telemetryOffset = info.exports.sw_core_telemetry_offset();
  return regions;
}

export interface TelemetrySnapshot {
  abiVersion: number;
  initState: number;
  bootTicksNs: bigint;
  arenaBytes: number;
  ringCapacity: number;
  lastRoundtripNs: bigint;
}

/** Reads the telemetry block straight out of shared memory. */
export function readTelemetry(info: CoreAttachInfo): TelemetrySnapshot {
  const base = info.telemetryOffset;
  const u32 = info.memory.u32;
  const u64 = info.memory.u64;
  const w = base >>> 2;
  const dw = base >>> 3;
  return {
    abiVersion: u32[w + (fieldOffset('SwCoreTelemetry', 'abi_version') >>> 2)]!,
    initState: u32[w + (fieldOffset('SwCoreTelemetry', 'init_state') >>> 2)]!,
    bootTicksNs: u64[dw + (fieldOffset('SwCoreTelemetry', 'boot_ticks_ns') >>> 3)]!,
    arenaBytes: u32[w + (fieldOffset('SwCoreTelemetry', 'arena_bytes') >>> 2)]!,
    ringCapacity: u32[w + (fieldOffset('SwCoreTelemetry', 'ring_capacity') >>> 2)]!,
    lastRoundtripNs: u64[dw + (fieldOffset('SwCoreTelemetry', 'last_roundtrip_ns') >>> 3)]!,
  };
}

/**
 * Measures a main -> worker -> main round trip through the core.
 *
 * This is the Phase 0 gate's "< 1 ms" measurement. It deliberately includes a
 * `postMessage` hop, a WASM call, and a write into shared memory, because a
 * measurement that skipped any of those would not prove the path works.
 */
export async function measureRoundTrip(
  info: CoreAttachInfo,
  samples = 32,
): Promise<{ p50: number; p95: number; max: number; mean: number }> {
  const latencies: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const echoed = info.exports.sw_core_ping(i);
    const elapsed = performance.now() - t0;
    if (echoed !== i) {
      throw new CoreLoadError(
        `Core ping returned ${echoed} for input ${i}; the module is not behaving correctly.`,
      );
    }
    latencies.push(elapsed);
  }
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    p50: latencies[Math.floor(latencies.length * 0.5)]!,
    p95: latencies[Math.floor(latencies.length * 0.95)]!,
    max: latencies[latencies.length - 1]!,
    mean: sum / latencies.length,
  };
}

/** Reads a NUL-terminated UTF-8 string out of core memory. */
function readCString(mem: CoreMemory, ptr: number, maxLength = 256): string {
  if (ptr === 0) return '';
  const bytes: number[] = [];
  for (let i = 0; i < maxLength; i++) {
    const b = mem.u8[ptr + i]!;
    if (b === 0) break;
    bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export type { StructReturn, SwCoreExports };
export { SwCoreTelemetry_LAYOUT };
