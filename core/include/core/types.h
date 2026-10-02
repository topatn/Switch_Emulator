// core/include/core/types.h
// SPDX-License-Identifier: MIT
//
// Foundational types for the emulation core. This header is the source of
// truth for the C ABI (docs/abi.md); `tools/gen-abi.mjs` parses it and emits
// the TypeScript mirrors under gen/.
//
// Portability note (Part 3.3): the core is compiled to wasm32 for v1. Every
// type here must be explicitly sized. Never use `long`, `int`, or any type
// whose width is implementation-defined.

#ifndef CORE_TYPES_H
#define CORE_TYPES_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Bumped whenever the exported C ABI changes incompatibly. The TS layer
// refuses to run against a mismatched module rather than crashing.
#define SW_ABI_VERSION 1u

// Sentinel used across the ABI for "no pointer" / "no size".
#define SW_NULL_HANDLE 0u

typedef enum SwStatus {
    SW_OK = 0,
    SW_ERR_INVALID_ARG = 1,
    SW_ERR_NOT_INITIALIZED = 2,
    SW_ERR_OUT_OF_MEMORY = 3,
    SW_ERR_UNSUPPORTED = 4,
} SwStatus;

// Compile-time guards. These are the invariants that let the TS mirror skip
// per-field endianness concerns entirely (wasm is little-endian).
#if defined(__BYTE_ORDER__) && defined(__ORDER_BIG_ENDIAN__)
#  if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#    error "switch-web core assumes a little-endian host (wasm32/x86-64)."
#  endif
#endif

#ifdef __cplusplus
static_assert(sizeof(void*) == 4,
              "v1 builds as wasm32; a 64-bit host build must define SW_ABI_POINTER_SIZE=8.");
#endif

// ---------------------------------------------------------------------------
// SwCoreTelemetry
//
// Written into the shared arena by the core and read by the TS shell for the
// Phase 0 latency budget measurement (Part 6, Phase 0 gate: a main->worker->
// main round trip under 1 ms). Also the anchor for the "progress & flags"
// SAB region described in Part 3.9, so it is deliberately small, fixed-size,
// and cache-line isolated.
//
// Field order is chosen for 8-byte alignment with no implicit padding:
//   0x00 u32 abi_version
//   0x04 u32 init_state          (0 = cold, 1 = ready, 2 = shut down)
//   0x08 u64 boot_ticks_ns
//   0x10 u32 arena_bytes
//   0x14 u32 ring_capacity
//   0x18 u64 last_roundtrip_ns
//   0x20 u64 reserved[2]
// Total: 0x30 (48 bytes). Two of these fit in one 64-byte cache line.
// ---------------------------------------------------------------------------
typedef struct SwCoreTelemetry {
    uint32_t abi_version;
    uint32_t init_state;
    uint64_t boot_ticks_ns;
    uint32_t arena_bytes;
    uint32_t ring_capacity;
    uint64_t last_roundtrip_ns;
    uint64_t reserved[2];
} SwCoreTelemetry;

#define SW_TELEMETRY_SIZE 48u

// ---------------------------------------------------------------------------
// SwGuestContext
//
// Part 3.2.3: all architectural state lives in a shared structure, never in
// WASM locals, because code units are separately instantiated modules and
// therefore share no register file. v0..v31 are last and 64-byte aligned so
// SIMD state does not false-share with the integer registers.
//
// Phase 0 declares the layout but does not yet instantiate it; generating the
// TS mirror now is what keeps the two sides from drifting.
// ---------------------------------------------------------------------------
#define SW_MAX_CORES 4u

typedef struct SwGuestContext {
    uint64_t x[31];        // x0..x30 (x31 = sp, 32-bit)
    uint32_t sp;
    uint32_t pc;
    uint32_t pstate;
    uint32_t cpsr_flags;   // packed NZCV
    uint32_t tpidr_el0;
    uint32_t tpidrro_el0;
    uint32_t fpcr;
    uint32_t fpsr;
    // x[31] (248) + 8 x u32 (32) = 280; pad to 320 so v[] starts on a 64-byte
    // boundary and the whole struct is exactly 13 cache lines.
    uint8_t  pad_to_64[40];
    uint8_t  v[32 * 16];   // v0..v31, 128-bit each, 64-byte aligned
} SwGuestContext;

#ifdef __cplusplus
static_assert(sizeof(SwGuestContext) == 832, "SwGuestContext layout changed; rerun npm run gen:abi.");
static_assert(sizeof(SwGuestContext) % 64 == 0, "SwGuestContext must stay cache-line sized.");
#endif

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // CORE_TYPES_H
