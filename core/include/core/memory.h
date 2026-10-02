// core/include/core/memory.h
// SPDX-License-Identifier: MIT
//
// Phase 0 skeleton of the Part 3.3 memory model ("P1. Sparse page table over a
// resident arena").
//
// The full page-table walker, TLB, and page-state tracking land in Phase 1.
// What exists now is the part every later subsystem depends on: one growable
// shared arena, allocated by the core, exported to JS as a SharedArrayBuffer,
// into which the guest RAM region, the command rings, and the telemetry block
// are sub-allocated.

#ifndef CORE_MEMORY_H
#define CORE_MEMORY_H

#include "core/types.h"

#ifdef __cplusplus
extern "C" {
#endif

// Default arena size when sw_core_init(0) is called. Sized to leave headroom
// under the wasm32 4 GiB ceiling for JIT code, audio rings, and the host's own
// allocations while still proving out multi-gigabyte guest allocation early
// (Phase 1 gate: "> 2 GiB guest allocation under the sparse arena").
#define SW_ARENA_DEFAULT_BYTES (256u * 1024u * 1024u)

// Hard ceiling on the arena, below the wasm32 maximum of 4 GiB.
#define SW_ARENA_MAX_BYTES (3072u * 1024u * 1024u)

// Arena region ids. The region table is the first thing the TS mirror reads,
// so region order is part of the ABI contract. Keep append-only.
typedef enum SwArenaRegion {
    SW_REGION_RESERVED = 0,
    SW_REGION_GUEST_RAM = 1,   // resident guest pages (P1 arena)
    SW_REGION_TLB_MMIO = 2,    // TLB arrays + MMIO window (Part 3.3)
    SW_REGION_CPU_CONTEXTS = 3,// SwGuestContext[SW_MAX_CORES]
    SW_REGION_NVN_RING = 4,    // NVN command ring (Part 3.5)
    SW_REGION_AUDIO_RING = 5,  // audren PCM ring (Part 3.6)
    SW_REGION_HID_STATE = 6,   // HID state struct (Part 3.7)
    SW_REGION_IO_RING = 7,     // fs / IO request ring (Part 3.8)
    SW_REGION_TELEMETRY = 8,   // SwCoreTelemetry
    SW_REGION_COUNT = 9,
} SwArenaRegion;

// A sub-range of the arena, in arena-relative offsets. Byte offsets (not guest
// addresses) so a region means the same thing before and after the MMU exists.
typedef struct SwArenaRange {
    uint32_t offset;
    uint32_t size;
    uint32_t region;
    uint32_t flags;  // SW_ARENA_F_* below
} SwArenaRange;

#define SW_ARENA_F_READ 0x1u
#define SW_ARENA_F_WRITE 0x2u
#define SW_ARENA_F_SHARED 0x4u   // touched by more than one worker

// Arena lifecycle. Not thread-safe: called only from the worker that owns the
// core instance, before guest execution starts.
void sw_arena_init(uint32_t arena_bytes);
void sw_arena_shutdown(void);

// Reserves `size` bytes in `region`, returns the arena-relative offset or
// SW_NULL_HANDLE on failure. Regions are carved in id order so the layout is
// reproducible across runs (which keeps the ABI mirror honest).
uint32_t sw_arena_reserve(uint32_t region, uint32_t size, uint32_t align);

// Returns the reserved range for a region, or a zeroed range if unreserved.
SwArenaRange sw_arena_range(uint32_t region);

// Arena offset -> pointer, or NULL if out of bounds.
void *sw_arena_ptr(uint32_t offset);

uint32_t sw_arena_size(void);
uint32_t sw_arena_used(void);

// Extends the arena by `delta_bytes`, returning the new total size (or the
// unchanged size if the allocation failed).
//
// IMPORTANT: with Emscripten's ALLOW_MEMORY_GROWTH a successful growth moves
// the base pointer, which detaches the exported memory buffer and invalidates
// every JS-side typed-array view over it. JS callers MUST re-derive their views
// after calling this. Never call it while a view is being used.
uint32_t sw_arena_grow(uint32_t delta_bytes);

// Writes the region table (SW_REGION_COUNT entries, SwArenaRange each) into
// `out`. Returns the number of bytes written.
uint32_t sw_arena_write_region_table(void *out, uint32_t out_capacity);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // CORE_MEMORY_H
