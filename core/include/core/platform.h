// core/include/core/platform.h
// SPDX-License-Identifier: MIT
//
// The exported C ABI surface (Part 4.1: "thin C ABI exported from the core").
//
// Rules for this header:
//   1. It is the contract in docs/abi.md. Adding a function is a minor change;
//      changing an existing signature requires SW_ABI_VERSION to be bumped.
//   2. No exceptions cross this boundary. All entry points are noexcept.
//   3. No std:: types appear in a signature. Only fixed-width ints and PODs.

#ifndef CORE_PLATFORM_H
#define CORE_PLATFORM_H

#include "core/types.h"

#ifdef __cplusplus
extern "C" {
#endif

// --- Identity --------------------------------------------------------------

// Returns SW_ABI_VERSION. The TS layer calls this first and refuses to run on
// a mismatch, which turns a stale cached .wasm into a clear message instead of
// a mysterious trap.
uint32_t sw_abi_version(void);

// Feature bits the core was built with. Lets the shell branch on SIMD/tail-call
// availability (Part 4.1: these features are "effectively mandatory") and
// report them in the diagnostics overlay.
#define SW_FEATURE_SIMD128 0x1u
#define SW_FEATURE_BULK_MEMORY 0x2u
#define SW_FEATURE_TAIL_CALL 0x4u
#define SW_FEATURE_SHARED_MEMORY 0x8u
#define SW_FEATURE_SIGN_EXT 0x10u

uint32_t sw_core_features(void);

// Human-readable build identification, e.g. "switch-web core 0.0.0 (emscripten
// 3.1.74, wasm32, simd128, tail-call)". Written by the build. Never NULL.
const char *sw_core_build_id(void);

// --- Lifecycle -------------------------------------------------------------

// Initializes the core and allocates the shared arena.
//
// `arena_bytes == 0` selects SW_ARENA_DEFAULT_BYTES. A request above
// SW_ARENA_MAX_BYTES is clamped rather than rejected, so the shell can pass a
// user preference through without validating it first.
//
// Returns SW_OK, or SW_ERR_OUT_OF_MEMORY if the arena could not be reserved.
// Idempotent: a second call with the same size returns SW_OK.
int32_t sw_core_init(uint32_t arena_bytes);

// Releases the arena. Safe to call without a matching init.
void sw_core_shutdown(void);

// 0 = cold, 1 = ready, 2 = shut down.
uint32_t sw_core_state(void);

// --- Arena -----------------------------------------------------------------

// Base of the shared arena. This is the pointer the SAB-backed memory is
// projected from, so it is always 0 in a correct build; it is still part of
// the ABI because the TS mirror asserts on it at attach time rather than
// assuming.
uint32_t sw_core_arena_ptr(void);
uint32_t sw_core_arena_size(void);
uint32_t sw_core_arena_used(void);

// Copies the region table out. See sw_arena_write_region_table.
uint32_t sw_core_region_table(void *out, uint32_t out_capacity);

// --- Telemetry -------------------------------------------------------------

// Pointer (arena offset) of the SwCoreTelemetry block, or SW_NULL_HANDLE.
uint32_t sw_core_telemetry_offset(void);

// Refreshes the telemetry block: state, arena sizes, and the elapsed time
// since the last ping.
void sw_core_telemetry_refresh(void);

// --- Phase 0 gate helpers --------------------------------------------------

// Returns its argument unchanged. Its only purpose is to give the shell a
// measurable main -> worker -> main round trip for the "under 1 ms" latency
// gate (Part 6, Phase 0), and to prove the module is genuinely executing
// rather than returning a cached result.
int32_t sw_core_ping(int32_t value);

// Monotonic clock in nanoseconds, from the same source used for guest timing
// (Part 3.4: accurate ticks are a correctness feature, not polish).
uint64_t sw_core_monotonic_ns(void);

// Records a round-trip sample so the telemetry block carries the value the
// shell displays. Called by sw_core_ping.
void sw_core_note_roundtrip(uint64_t elapsed_ns);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // CORE_PLATFORM_H
