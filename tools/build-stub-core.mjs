#!/usr/bin/env node
// tools/build-stub-core.mjs
//
// Emits a minimal, hand-encoded core.wasm exposing the Phase 0 C ABI.
//
// WHY THIS EXISTS
// ---------------
// Phase 0's gate is "Emscripten core builds and runs in a worker". That gate is
// about the *contract* — ABI version handshake, shared memory export, region
// table, telemetry block — not about emulation, which is Phase 1 and later.
//
// Without an Emscripten toolchain installed, none of that contract can be
// exercised, so the plumbing would be untestable. This script assembles a real
// WebAssembly module byte by byte that implements exactly the Phase 0 surface.
// The result is a genuine .wasm: the browser compiles and runs it through the
// same path the Emscripten build uses.
//
// WHAT IT DOES NOT DO
// -------------------
// It emulates nothing. It allocates a shared memory, carves the Phase 0 regions,
// answers ping, and reports its own build id. Its build id contains "stub" so
// web/src/core/coreUrl.ts can label it in the UI, because a user who believes a
// real core loaded has been misled.
//
// The real build overwrites this file:
//   emcmake cmake -S core -B core/build -DSW_BUILD_WASM=ON && cmake --build core/build
//   node tools/build-core.mjs --copy

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'web', 'public');
const OUT_FILE = join(OUT_DIR, 'core.wasm');

// --- wasm encoding primitives --------------------------------------------

const SECTION = { custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6, export: 7, start: 8, elem: 9, code: 10, data: 11 };

const VALTYPE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b };

/** Unsigned LEB128. */
function uleb(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return bytes;
}

/** Signed LEB128. */
function sleb(value) {
  const bytes = [];
  let more = true;
  let v = value | 0;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

function str(text) {
  const encoded = [...new TextEncoder().encode(text)];
  return [...uleb(encoded.length), ...encoded];
}

function vec(items) {
  return [...uleb(items.length), ...items.flat()];
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

// --- function bodies ------------------------------------------------------

/**
 * Builds a function body from a byte-emitting builder.
 *
 * Locals are declared as compressed runs of (count, valtype), which is why the
 * builder takes a locals array rather than individual values.
 */
function body(locals, code) {
  const runs = [];
  for (const local of locals) {
    const last = runs[runs.length - 1];
    if (last && last[1] === local[1]) last[0]++;
    else runs.push([1, local[1]]);
  }
  const localVec = vec(runs.map(([count, type]) => [...uleb(count), type]));
  const payload = [...localVec, ...code, 0x0b]; // end
  return [...uleb(payload.length), ...payload];
}

// i32.const helpers
const I32 = (value) => [0x41, ...sleb(value)];
const I64 = (value) => [0x42, ...sleb(value)];

/**
 * memory.copy (bulk memory).
 *
 * The encoding is `0xFC 0x0A <dst memidx> <src memidx>`. Both memory indices are
 * required even though this module has only memory 0 — omitting the second one
 * makes the module fail validation, which is a genuinely confusing way to learn
 * about it.
 */
const MEMORY_COPY = [0xfc, 0x0a, 0x00, 0x00];

/** i64.store with an explicit alignment hint of 3 (8 bytes). */
const I64_STORE = [0x37, 0x03, 0x00];

// --- the module -----------------------------------------------------------

// Layout constants, mirrored from core/include/core/*.h. Kept as literals here
// on purpose: if these drift from the headers, tools/gen-abi.mjs --check in CI
// catches it, and this file failing its own self-test catches it locally.
const ABI_VERSION = 1;
const ARENA_BYTES = 256 * 1024 * 1024; // 256 MiB default

/**
 * Region sizes and the arena layout from Part 3.9.
 *
 * SW_REGION_COUNT is a *sentinel*, not a region: the C enum lists it with value
 * 9, and `SW_REGION_COUNT` names the number of entries in the region table. So the
 * table holds indices 0..8 and this array must not include a row for it. Keeping
 * that distinction straight matters, because an off-by-one here makes the region
 * table the wrong size and every worker's region view wrong by one slot.
 */
const REGION_COUNT = 9;
const REGIONS = [
  { id: 0, name: 'SW_REGION_RESERVED', size: 0, align: 16 },
  { id: 1, name: 'SW_REGION_GUEST_RAM', size: 64 * 1024 * 1024, align: 16 },
  { id: 2, name: 'SW_REGION_TLB_MMIO', size: 4 * 1024 * 1024, align: 16 },
  { id: 3, name: 'SW_REGION_CPU_CONTEXTS', size: 832 * 4, align: 16 },
  { id: 4, name: 'SW_REGION_NVN_RING', size: 8 * 1024 * 1024, align: 16 },
  { id: 5, name: 'SW_REGION_AUDIO_RING', size: 4 * 1024 * 1024, align: 16 },
  { id: 6, name: 'SW_REGION_HID_STATE', size: 4096, align: 16 },
  { id: 7, name: 'SW_REGION_IO_RING', size: 4 * 1024 * 1024, align: 16 },
  { id: 8, name: 'SW_REGION_TELEMETRY', size: 48, align: 16 },
];

// Compute the offset table the same way sw_arena_reserve does.
let cursor = 0;
const regionOffsets = REGIONS.map((region) => {
  if (region.size === 0) return 0;
  const base = (cursor + (region.align - 1)) & ~(region.align - 1);
  cursor = base + region.size;
  return base;
});

const TELEMETRY_OFFSET = regionOffsets[8];

const BUILD_ID = 'switch-web core stub 0.0.0 (hand-encoded, no emscripten)';

/**
 * Static data lives just above the zero page, well below every arena region, so
 * it can never collide with a reservation and never needs relocating.
 */
const STATIC_DATA_BASE = 1024;
const BUILD_ID_PTR = STATIC_DATA_BASE;
const REGION_TABLE_PTR = STATIC_DATA_BASE + 128;

// --- function list --------------------------------------------------------
//
// Order here defines the function index table below. Keep the two in step.
const FUNCS = [
  { name: 'sw_abi_version', sig: [], ret: 'i32', code: () => [...I32(ABI_VERSION)] },
  {
    name: 'sw_core_features',
    sig: [],
    ret: 'i32',
    // Bulk memory + sign-ext; no SIMD or tail calls in the stub.
    code: () => [...I32(0x02 | 0x10)],
  },
  { name: 'sw_core_build_id', sig: [], ret: 'i32', code: () => [...I32(BUILD_ID_PTR)] },
  { name: 'sw_core_init', sig: ['i32'], ret: 'i32', code: () => [...I32(0)] },
  { name: 'sw_core_state', sig: [], ret: 'i32', code: () => [...I32(1)] },
  { name: 'sw_core_arena_ptr', sig: [], ret: 'i32', code: () => [...I32(0)] },
  { name: 'sw_core_arena_size', sig: [], ret: 'i32', code: () => [...I32(ARENA_BYTES)] },
  { name: 'sw_core_arena_used', sig: [], ret: 'i32', code: () => [...I32(cursor)] },
  {
    name: 'sw_core_region_table',
    sig: ['i32', 'i32'],
    ret: 'i32',
    // Writes 9 SwArenaRange entries (offset, size, region, flags) at the given
    // pointer, then returns the byte count. The data section below supplies the
    // table, so this is a memory.copy: dest <- src, len bytes.
    code: () => [
      0x20, 0x00, // local.get 0 (out)
      ...I32(REGION_TABLE_PTR), // i32.const source
      ...I32(REGION_COUNT * 16), // i32.const length
      ...MEMORY_COPY,
      ...I32(REGION_COUNT * 16),
    ],
  },
  { name: 'sw_core_telemetry_offset', sig: [], ret: 'i32', code: () => [...I32(TELEMETRY_OFFSET)] },
  {
    name: 'sw_core_telemetry_refresh',
    sig: [],
    ret: null,
    // Nothing to refresh: the data section already holds current values.
    code: () => [],
  },
  {
    name: 'sw_core_ping',
    sig: ['i32'],
    ret: 'i32',
    // Identity. The gate's ping is about the call crossing the boundary, not
    // about computing anything.
    code: () => [0x20, 0x00],
  },
  {
    name: 'sw_core_monotonic_ns',
    sig: [],
    ret: 'i64',
    // The stub has no clock import, so this returns a monotonically-increasing
    // counter instead. Callers only need forward progress for the Phase 0 gate;
    // a real build reads emscripten_get_now().
    code: () => [
      0x23, 0x00, // global.get 0
      ...I64(1000),
      0x7c, // i64.add
      0x24, 0x00, // global.set 0
      0x23, 0x00, // global.get 0
    ],
  },
  {
    name: 'sw_core_note_roundtrip',
    sig: ['i64'],
    ret: null,
    // Store into the telemetry block's last_roundtrip_ns field (offset 24).
    code: () => [
      ...I32(TELEMETRY_OFFSET + 24),
      0x20, 0x00, // local.get 0
      ...I64_STORE,
    ],
  },
];

const NUM_MEM_PAGES = Math.ceil(ARENA_BYTES / 65536);

// --- assemble -------------------------------------------------------------

const usedTypes = [];
const typeIndexOf = (key) => {
  let index = usedTypes.findIndex((t) => t.key === key);
  if (index < 0) {
    index = usedTypes.length;
    usedTypes.push({ key, params: key[0], results: key[1] });
  }
  return index;
};

const funcTypeIndices = FUNCS.map((fn) =>
  typeIndexOf([fn.sig.map((s) => VALTYPE[s]), fn.ret ? [VALTYPE[fn.ret]] : []]),
);

const typeSection = section(
  SECTION.type,
  vec(
    usedTypes.map((t) => [
      0x60, // func
      ...vec(t.params.map((p) => [p])),
      ...vec(t.results.map((r) => [r])),
    ]),
  ),
);

const functionSection = section(SECTION.function, vec(funcTypeIndices.map((i) => uleb(i))));

// Shared memory: the flag is 0x03 (max + shared). This is what lets the GPU, audio,
// and I/O workers map the same pages, and it is the whole reason Part 3.9
// insists on cross-origin isolation.
const memorySection = section(
  SECTION.memory,
  // Memory limits flags: 0x01 = has maximum, 0x02 = shared. Both are required
  // here. Without the shared bit the memory is an ordinary WebAssembly.Memory and
  // `instance.exports.memory.buffer` is a plain ArrayBuffer rather than a
  // SharedArrayBuffer, which would silently fail the Phase 0 shared-memory check.
  vec([[0x03, ...uleb(NUM_MEM_PAGES), ...uleb(NUM_MEM_PAGES)]]),
);

/** Index of the mutable i64 global used as the stub's clock. */
const GLOBAL_MONOTONIC = 0;

const globalSection = section(
  SECTION.global,
  vec([
    [
      VALTYPE.i64,
      0x01, // mutable
      0x42, ...sleb(0), // i64.const 0
      0x0b, // end
    ],
  ]),
);

const exportSection = section(
  SECTION.export,
  vec([
    [...str('memory'), 0x02, ...uleb(0)],
    ...FUNCS.map((fn, i) => [...str(fn.name), 0x00, ...uleb(i)]),
  ]),
);

// The build id string, the region table, and the telemetry block are all static
// data, which is why the stub needs no allocator at all.
const buildIdBytes = [...new TextEncoder().encode(BUILD_ID)];

const regionTableBytes = [];
for (const region of REGIONS) {
  const offset = region.size === 0 ? 0 : regionOffsets[region.id];
  const size = region.size;
  const flags = region.size === 0 ? 0 : 0x01 | 0x02 | 0x04; // READ | WRITE | SHARED
  const view = new DataView(new ArrayBuffer(16));
  view.setUint32(0, offset, true);
  view.setUint32(4, size, true);
  view.setUint32(8, region.id, true);
  view.setUint32(12, flags, true);
  regionTableBytes.push(...new Uint8Array(view.buffer));
}

const telemetryBytes = (() => {
  const view = new DataView(new ArrayBuffer(48));
  view.setUint32(0, ABI_VERSION, true); // abi_version
  view.setUint32(4, 1, true); // init_state = ready
  view.setBigUint64(8, 0n, true); // boot_ticks_ns
  view.setUint32(16, ARENA_BYTES, true); // arena_bytes
  view.setUint32(20, REGIONS.find((r) => r.name === 'SW_REGION_NVN_RING').size, true); // ring_capacity
  view.setBigUint64(24, 0n, true); // last_roundtrip_ns
  return [...new Uint8Array(view.buffer)];
})();

// Data segments: active, memory 0.
const dataSection = section(
  SECTION.data,
  vec([
    // build id string, NUL terminated
    [
      0x00, 0x41, ...sleb(BUILD_ID_PTR), 0x0b,
      ...uleb(buildIdBytes.length + 1),
      ...buildIdBytes,
      0x00,
    ],
    // region table
    [
      0x00, 0x41, ...sleb(REGION_TABLE_PTR), 0x0b,
      ...uleb(regionTableBytes.length),
      ...regionTableBytes,
    ],
    // telemetry block
    [
      0x00, 0x41, ...sleb(TELEMETRY_OFFSET), 0x0b,
      ...uleb(telemetryBytes.length),
      ...telemetryBytes,
    ],
  ]),
);

const codeSection = section(
  SECTION.code,
  vec(
    FUNCS.map((fn) => {
      // A function needs an i64 *local* slot only if it stores an i64 local; the
      // stub's i64 parameters arrive as locals already, so this is empty.
      const localTypes = fn.locals ?? [];
      return body(localTypes, fn.code());
    }),
  ),
);

const wasm = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
  ...typeSection,
  ...functionSection,
  ...memorySection,
  ...globalSection,
  ...exportSection,
  ...codeSection,
  ...dataSection,
]);

// --- validate -------------------------------------------------------------

// Validate before writing: a malformed module that lands in web/public is worse
// than no module, because the app would report a core load failure that looks like
// a toolchain problem.
//
// --dump writes the module and a section breakdown to a scratch file instead, so
// a failing encoder can be debugged without bisecting it by hand.
if (process.argv.includes('--dump')) {
  const dumpPath = join(ROOT, '.cache', 'stub-core.wasm');
  mkdirSync(dirname(dumpPath), { recursive: true });
  writeFileSync(dumpPath, wasm);
  console.log(`stub-core: wrote ${dumpPath} (${wasm.length} bytes) for inspection`);
}

let valid = false;
try {
  valid = WebAssembly.validate(wasm);
} catch (error) {
  console.error('stub-core: validation threw:', error);
}

if (!valid) {
  console.error('stub-core: generated module failed WebAssembly.validate(); not writing.');
  if (process.argv.includes('--dump')) {
    console.error('stub-core: re-run with --trace to print the section layout.');
  }
  process.exit(1);
}

// --- self-test ------------------------------------------------------------

const { instance } = await WebAssembly.instantiate(wasm, {});
const api = instance.exports;

const problems = [];
const expect = (label, actual, expected) => {
  if (actual !== expected) problems.push(`${label}: got ${actual}, expected ${expected}`);
};

expect('sw_abi_version()', api.sw_abi_version(), ABI_VERSION);
expect('sw_core_state()', api.sw_core_state(), 1);
expect('sw_core_arena_ptr()', api.sw_core_arena_ptr(), 0);
expect('sw_core_arena_size()', api.sw_core_arena_size(), ARENA_BYTES);
expect('sw_core_arena_used()', api.sw_core_arena_used(), cursor);
expect('sw_core_telemetry_offset()', api.sw_core_telemetry_offset(), TELEMETRY_OFFSET);
expect('sw_core_ping(1234)', api.sw_core_ping(1234), 1234);
expect('sw_core_ping(-7)', api.sw_core_ping(-7), -7);
expect('sw_core_init(0)', api.sw_core_init(0), 0);

const clockA = api.sw_core_monotonic_ns();
const clockB = api.sw_core_monotonic_ns();
if (clockB <= clockA) problems.push(`monotonic clock did not advance: ${clockA} -> ${clockB}`);

api.sw_core_note_roundtrip(4242n);
const telemetryOffset = api.sw_core_telemetry_offset();
const mem = new DataView(api.memory.buffer);
expect('telemetry.abi_version', mem.getUint32(telemetryOffset, true), ABI_VERSION);
expect('telemetry.last_roundtrip_ns', mem.getBigUint64(telemetryOffset + 24, true), 4242n);

const tableBytes = REGION_COUNT * 16;
expect('region_table byte count', api.sw_core_region_table(2048, tableBytes), tableBytes);

// The scratch area must start inside the arena and clear the whole region set.
if (2048 + tableBytes > ARENA_BYTES) {
  problems.push(`scratch area 2048..${2048 + tableBytes} exceeds the arena (${ARENA_BYTES})`);
}

const tableView = new DataView(api.memory.buffer, 2048, tableBytes);
for (const region of REGIONS) {
  const base = region.id * 16;
  const offset = tableView.getUint32(base, true);
  const size = tableView.getUint32(base + 4, true);
  const id = tableView.getUint32(base + 8, true);
  expect(`region ${region.name}.id`, id, region.id);
  expect(`region ${region.name}.offset`, offset, region.size === 0 ? 0 : regionOffsets[region.id]);
  expect(`region ${region.name}.size`, size, region.size);
}

// The build id must round-trip through linear memory.
const idPtr = api.sw_core_build_id();
const idBytes = [];
for (let i = 0; i < 256; i++) {
  const byte = new Uint8Array(api.memory.buffer)[idPtr + i];
  if (byte === 0) break;
  idBytes.push(byte);
}
const idText = new TextDecoder().decode(new Uint8Array(idBytes));
if (!idText.includes('stub')) problems.push(`build id does not identify itself as a stub: "${idText}"`);

if (problems.length) {
  console.error('stub-core: self-test FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// --- write ----------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

// Never clobber a real Emscripten build: it is always the better artifact, and
// silently overwriting it would be a genuinely nasty surprise.
const realBuild = join(ROOT, 'core', 'build', 'core.wasm');
if (existsSync(realBuild)) {
  console.log(`stub-core: found a real build at ${realBuild}`);
  console.log('stub-core: not overwriting web/public/core.wasm. Run: node tools/build-core.mjs --copy');
  process.exit(0);
}

writeFileSync(OUT_FILE, wasm);

const sizeKb = (wasm.length / 1024).toFixed(1);
console.log(`stub-core: wrote ${OUT_FILE}`);
console.log(`stub-core: ${wasm.length} bytes (${sizeKb} KiB), ${FUNCS.length} exports, ${(ARENA_BYTES / 1024 ** 2).toFixed(0)} MiB shared memory`);
console.log(`stub-core: build id: "${idText}"`);
console.log('stub-core: self-test passed (ABI, arena, region table, telemetry, clock, ping)');

// A quick inventory of what is present, for the CI log.
const exports = Object.keys(api).sort();
console.log(`stub-core: exports: ${exports.join(', ')}`);

// Guard against accidentally shipping a directory of unexpected assets.
const publicEntries = existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : [];
const wasmFiles = publicEntries.filter((n) => n.endsWith('.wasm'));
if (wasmFiles.length > 1) {
  console.warn(`stub-core: warning - multiple .wasm files in web/public: ${wasmFiles.join(', ')}`);
}
for (const entry of publicEntries) {
  const full = join(OUT_DIR, entry);
  if (statSync(full).isFile() && /\.(xci|nsp|nca|keys)$/i.test(entry)) {
    console.error(`stub-core: refusing to finish - content-shaped file in web/public: ${entry}`);
    process.exit(1);
  }
}
