# The C ABI and SAB layout contract

This document is the contract between `core/` (C++ → WASM) and `web/` (TypeScript).
It is normative: the C header in `core/include/core/platform.h` is the source of
truth, `gen/abi.json` and `gen/abi.ts` are generated from it, and this file
explains the parts a signature alone does not convey.

**If you change a signature here, bump `SW_ABI_VERSION`.** The shell refuses to run
against a mismatched module rather than crashing, so the cost of forgetting is a
clear error message; the cost of *not* bumping is that message not appearing.

---

## 1. Regenerating the mirrors

```sh
npm run gen:abi          # regenerate gen/abi.json and gen/abi.ts
node tools/gen-abi.mjs --check   # CI: fail if the checked-in mirrors are stale
```

`tools/gen-abi.mjs` parses only the subset of C the ABI headers actually use:
fixed-width typedefs, enums, POD structs, and `#define`d integer constants. It is
not a C compiler and does not try to be. Anything it cannot parse is a **hard
error naming the file and line**, so an unsupported construct can never quietly
produce a wrong mirror.

Set `SW_GEN_ABI_TRACE=1` to log every parser dispatch decision — the fastest way
to find out where a header parse went wrong.

---

## 2. Shape of the boundary

Three rules, from Part 4.1's "keep the ABI surface tiny and explicit":

1. **No exceptions cross the boundary.** Every entry point is `noexcept` in
   practice. A `throw` past this line is an abort inside WASM.
2. **No C++ types in a signature.** Only fixed-width integers, `void*`, and PODs
   whose layout `tools/gen-abi.mjs` can compute.
3. **Every type is explicitly sized.** Never `long`, never `int`. On wasm32 a bare
   `int` is 32-bit and a bare `long` is also 32-bit, which differs from every
   native host and makes the ABI silently unportable.

### wasm32 assumptions

The core is built as **wasm32** for v1. Consequences baked into the layout:

| Assumption | Where it shows up |
|---|---|
| Pointers are 32-bit | `sw_core_arena_ptr()` returns `uint32_t`; `POINTER_SIZE = 4` |
| Endianness is little-endian | all TS reads use `DataView` with `littleEndian = true` |
| Struct alignment caps at 16 | `SwGuestContext` has no member wider than 16, so it is moot today, but `layoutStruct()` applies the cap |
| Maximum linear memory is 4 GiB | `SW_ARENA_MAX_BYTES` is 3 GiB, deliberately below it |

**Future wasm64.** Part 3.3's P2 path changes one function: guest physical address →
host location. For the ABI it means flipping `POINTER_SIZE` to 8, switching the
64-bit TS views in `gen/abi.ts`, and bumping `SW_ABI_VERSION`. The
`VIEW64`/`VIEW32` split in the generated file exists so that swap is a one-line
change.

---

## 3. Version handshake

```
sw_abi_version() -> uint32_t
```

Called **first**, before anything else. The shell compares it to `ABI_VERSION`
from `gen/abi.ts`:

- match → proceed
- mismatch → `CoreLoadError` with the message "ABI mismatch: the shell expects
  v1 but the core module reports v2"

This exists because the single most likely failure after a partial rebuild is a
stale cached `.wasm`. Without the check, that surfaces as a wrong struct offset and
a memory-corruption bug. With it, it surfaces as one line.

`sw_core_features()` is the second call. It returns a bitmask so the shell can
branch on what the build actually supports:

| Bit | Feature | Why it matters |
|---|---|---|
| `SW_FEATURE_SIMD128` | WASM SIMD | **Hard requirement for v1.** Backs FPSIMD/NEON translation and the hot memory-move helpers in the JIT (Part 3.2.3). |
| `SW_FEATURE_BULK_MEMORY` | `memory.copy`/`fill` | Same. |
| `SW_FEATURE_TAIL_CALL` | `return_call_indirect` | Guest stacks are deep; without tail calls a WASM-hosted guest stack overflows (Part 3.2.3). |
| `SW_FEATURE_SIGN_EXT` | sign-extension ops | The JIT emits these. |
| `SW_FEATURE_SHARED_MEMORY` | shared linear memory | **Architectural.** Without it guest RAM cannot be read by other workers at all. |

`SW_FEATURE_SHARED_MEMORY` is checked by the shell and reported as an error, not a
warning: a non-shared memory means no emulation is possible, no matter what else
succeeded.

---

## 4. Lifecycle

```
sw_core_init(arena_bytes) -> int32_t     // SwStatus
sw_core_shutdown() -> void
sw_core_state()    -> uint32_t           // 0 cold, 1 ready, 2 shut down
```

- `sw_core_init(0)` selects `SW_ARENA_DEFAULT_BYTES` (256 MiB).
- A request above `SW_ARENA_MAX_BYTES` (3 GiB) is **clamped, not rejected**, so
  the shell can pass a user preference through without validating it first.
- Idempotent: a second call with the same size returns `SW_OK`.
- The shell clamps independently to the same ceiling, so the boot request and the
  `booted` report agree.

`SwStatus` is a flat enum — `SW_OK`, `SW_ERR_INVALID_ARG`, `SW_ERR_NOT_INITIALIZED`,
`SW_ERR_OUT_OF_MEMORY`, `SW_ERR_UNSUPPORTED`. No struct returns, no rich error
objects; a failure reason is conveyed by which code you get, and the shell maps it
to a remedy.

---

## 5. The arena

Phase 0 ships the arena sub-allocator. The page-table walker and TLB land in
Phase 1.

```
sw_arena_reserve(region, size, align) -> uint32_t   // offset, or SW_NULL_HANDLE
sw_arena_range(region)                -> SwArenaRange
sw_arena_ptr(offset)                  -> void*
sw_arena_grow(delta_bytes)            -> uint32_t   // new total, or unchanged
```

### 5.1 Region table

`sw_core_region_table(out, capacity)` writes `SW_REGION_COUNT` `SwArenaRange`
entries and returns the byte count, or `0` if the buffer is too small or null.

```
struct SwArenaRange {   // 16 bytes
    uint32_t offset;    // arena-relative, not a guest address
    uint32_t size;
    uint32_t region;    // SwArenaRegion id
    uint32_t flags;     // SW_ARENA_F_READ | WRITE | SHARED
};
```

Regions are carved in id order at `init`, so the layout is a pure function of the
arena size. Later phases reserve lazily; the table format does not change.

| Id | Region | Phase 0 size | Purpose (Part 3.9) |
|---|---|---|---|
| 0 | `RESERVED` | 0 | Sentinel. Always size 0. |
| 1 | `GUEST_RAM` | 64 MiB | Resident guest pages (P1 arena) |
| 2 | `TLB_MMIO` | 4 MiB | TLB arrays + MMIO window |
| 3 | `CPU_CONTEXTS` | 3.3 KiB | `SwGuestContext[4]` |
| 4 | `NVN_RING` | 8 MiB | NVN command ring |
| 5 | `AUDIO_RING` | 4 MiB | audren PCM ring |
| 6 | `HID_STATE` | 4 KiB | HID state struct |
| 7 | `IO_RING` | 4 MiB | fs / IO request ring |
| 8 | `TELEMETRY` | 48 B | `SwCoreTelemetry` |

> **`SW_REGION_COUNT` is a sentinel, not a region.** The C enum lists it with
> value 9 and `SW_REGION_COUNT` names the number of table entries, so the table
> holds indices 0–8. An off-by-one here makes every worker's region view wrong by
> one slot. This distinction has already caused one bug during development
> (`tools/build-stub-core.mjs` had it), which is why it is written down.

Offsets are **arena-relative bytes**, not guest addresses, so a region means the
same thing before and after the MMU exists.

### 5.2 Growth invalidates views — read this before calling `sw_arena_grow`

With Emscripten's `ALLOW_MEMORY_GROWTH`, a successful growth **may move the base
pointer**. That detaches the exported memory buffer and invalidates every
`Uint8Array`/`DataView` over it. A stale view does not throw — it reads whatever
the new heap has since placed there, which is silent corruption.

The protocol, implemented in `web/src/workers/common.ts`:

```ts
const bufferBefore = info.memory.buffer;
const arenaBytes = info.exports.sw_arena_grow(delta);

if (info.wasmMemory.buffer !== bufferBefore) {
  info.memory = makeCoreMemory(info.wasmMemory);   // re-derive EVERYTHING
}
```

Compare **buffer identity**, not sizes. Two allocations of the same size are still
different objects, and comparing lengths would miss exactly the case that matters.

Never call `sw_arena_grow` while a view is in use.

---

## 6. Telemetry

```
sw_core_telemetry_offset() -> uint32_t   // arena offset, or SW_NULL_HANDLE
sw_core_telemetry_refresh() -> void
```

```
struct SwCoreTelemetry {   // 48 bytes, two per cache line
    uint32_t abi_version;      // 0x00
    uint32_t init_state;       // 0x04
    uint64_t boot_ticks_ns;    // 0x08
    uint32_t arena_bytes;      // 0x10
    uint32_t ring_capacity;    // 0x14
    uint64_t last_roundtrip_ns;// 0x18
    uint64_t reserved[2];      // 0x20
};
```

Field order is chosen for 8-byte alignment with no implicit padding. Two of these
fit in one 64-byte cache line, which is the point: it is written on every ping and
read by the shell, so false-sharing it against guest RAM would be measurable.

---

## 7. The Phase 0 latency gate

```
sw_core_ping(value) -> int32_t     // returns value unchanged
sw_core_monotonic_ns() -> uint64_t
sw_core_note_roundtrip(elapsed_ns) -> void
```

`sw_core_ping` is deliberately trivial. It exists so the shell can measure a round
trip that crosses a real boundary — `postMessage` hop, WASM call, shared-memory
write — and prove the path works. It also reads the telemetry block, so a module
with a stale ABI reports `SW_ERR_INVALID_ARG` instead of silently answering.

**The gate:** Part 6 requires a main → worker → main round trip under 1 ms.
`sw_core_ping` *inside* the worker measures sub-microsecond; the shell's
`measureRoundTrip()` measures the full loop including two `postMessage` hops,
which is the number the gate is about. Measured on this machine: p50 0.045 ms,
p95 0.080 ms, max 0.350 ms over 64 samples.

---

## 8. `SwGuestContext`

Declared now, generated into the TS mirror now, allocated but not yet written by
Phase 0. Declaring it early is deliberate: Part 3.2.3's field order is an
architectural decision (SIMD state last and 64-byte aligned so it does not
false-share with the integer registers), and a layout that drifts after the JIT
depends on it is a layout that breaks the JIT.

```
struct SwGuestContext {   // 832 bytes = 13 cache lines exactly
    uint64_t x[31];       // 0x000  x0..x30 (x31 = sp, 32-bit)
    uint32_t sp, pc, pstate, cpsr_flags;
    uint32_t tpidr_el0, tpidrro_el0, fpcr, fpsr;
    uint8_t  pad_to_64[40];  // 0x118  -> v[] starts at 0x140
    uint8_t  v[512];         // 0x140  v0..v31, 128-bit each
};
```

`pad_to_64` is 40 bytes because 248 + 32 = 280, and 280 is not a multiple of 64.
Both `sizeof` and the cache-line multiple are `static_assert`ed in the header, so
changing a field count fails the core build rather than silently misaligning
`v[]`.

All architectural state lives in this structure and **never in WASM locals**,
because code units are separately instantiated modules and therefore share no
register file. That is the single most consequential decision in Part 3.2.3, and
it is why this struct exists as an ABI type rather than as an implementation
detail.

---

## 9. Required exports

The shell checks for these by name before touching anything. A module missing any
of them produces a `CoreLoadError` naming the missing symbols, because the usual
cause is Emscripten's `EXPORTED_FUNCTIONS` drifting from the header.

```
sw_abi_version  sw_core_features  sw_core_build_id  sw_core_init
sw_core_state   sw_core_arena_size sw_core_region_table
sw_core_telemetry_offset  sw_core_ping  sw_core_monotonic_ns
```

`sw_core_build_id` returns a pointer to a **NUL-terminated string in linear
memory**, read with `readCString()` (capped at 256 bytes). The stub core returns a
string containing "stub", which is how the shell labels it in the UI — a user who
believed a real core had loaded has been misled.

---

## 10. Adding an export

1. Declare it in `core/include/core/platform.h` with a comment saying why it exists.
2. Implement it in `core/src/platform/init.cpp`.
3. Add it to `EXPORTED_FUNCTIONS` in `core/CMakeLists.txt`.
4. `npm run gen:abi` — the mirror picks it up automatically.
5. Add it to `required` in `web/src/core/instantiate.ts` if the shell must have it
   before proceeding.
6. Add it to the hand-encoded stub in `tools/build-stub-core.mjs`, **and** to its
   self-test. The stub exists so the plumbing is testable without a toolchain;
   leaving it behind means the pipeline is silently untested on machines that lack
   Emscripten.
7. If it changes a struct, run `node tools/gen-abi.mjs --check` and commit.

Bumping `SW_ABI_VERSION` is required only for incompatible changes: a new export
is additive and a stale module simply lacks the symbol, which step 5 catches with
a better message.
