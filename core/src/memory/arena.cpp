// core/src/memory/arena.cpp
// SPDX-License-Identifier: MIT
//
// Phase 0 arena allocator. See core/include/core/memory.h and Part 3.3.

#include "core/memory.h"
#include "core/platform.h"

#include <stdlib.h>
#include <string.h>

namespace {

struct Range {
    uint32_t offset;
    uint32_t size;
    uint32_t align;
    bool     reserved;
};

Range g_regions[SW_REGION_COUNT];
uint8_t *g_arena = nullptr;
uint32_t g_arena_bytes = 0;
uint32_t g_arena_used = 0;
bool     g_initialized = false;

// Default carve sizes per region. Guest RAM is deliberately small at Phase 0;
// the >2 GiB guest allocation gate is Phase 1, once the page-table model can
// actually stand behind the reservation.
uint32_t default_region_size(uint32_t region) {
    switch (region) {
        case SW_REGION_GUEST_RAM:    return 64u * 1024u * 1024u;
        case SW_REGION_TLB_MMIO:     return 4u * 1024u * 1024u;
        case SW_REGION_CPU_CONTEXTS: return (uint32_t)sizeof(SwGuestContext) * SW_MAX_CORES;
        case SW_REGION_NVN_RING:     return 8u * 1024u * 1024u;
        case SW_REGION_AUDIO_RING:   return 4u * 1024u * 1024u;
        case SW_REGION_HID_STATE:    return 4u * 1024u;
        case SW_REGION_IO_RING:      return 4u * 1024u * 1024u;
        case SW_REGION_TELEMETRY:    return SW_TELEMETRY_SIZE;
        default:                     return 0;
    }
}

}  // namespace

extern "C" void sw_arena_init(uint32_t arena_bytes) {
    if (g_initialized) {
        return;
    }
    if (arena_bytes == 0) {
        arena_bytes = SW_ARENA_DEFAULT_BYTES;
    }
    if (arena_bytes > SW_ARENA_MAX_BYTES) {
        arena_bytes = SW_ARENA_MAX_BYTES;
    }

    memset(g_regions, 0, sizeof(g_regions));

    g_arena = static_cast<uint8_t *>(calloc(1, arena_bytes));
    if (g_arena == nullptr) {
        g_arena_bytes = 0;
        g_arena_used = 0;
        return;
    }
    g_arena_bytes = arena_bytes;
    g_initialized = true;

    // Reserve every region up front, in id order, so the layout is a pure
    // function of the arena size. Later phases reserve lazily instead; the
    // region table format does not change either way.
    for (uint32_t r = 1; r < SW_REGION_COUNT; ++r) {
        sw_arena_reserve(r, default_region_size(r), 16);
    }
}

extern "C" void sw_arena_shutdown(void) {
    if (g_arena != nullptr) {
        free(g_arena);
        g_arena = nullptr;
    }
    memset(g_regions, 0, sizeof(g_regions));
    g_arena_bytes = 0;
    g_arena_used = 0;
    g_initialized = false;
}

extern "C" uint32_t sw_arena_reserve(uint32_t region, uint32_t size, uint32_t align) {
    if (!g_initialized || region == 0 || region >= SW_REGION_COUNT || size == 0) {
        return SW_NULL_HANDLE;
    }
    if (g_regions[region].reserved) {
        return g_regions[region].offset;
    }
    if (align == 0) {
        align = 16;
    }

    // Keep every region start aligned so a region can be handed to a worker as
    // a typed-array view without a second alignment pass.
    uint32_t base = (g_arena_used + (align - 1)) & ~(align - 1);
    uint64_t end = static_cast<uint64_t>(base) + size;
    if (end > g_arena_bytes) {
        return SW_NULL_HANDLE;
    }

    g_regions[region].offset = base;
    g_regions[region].size = static_cast<uint32_t>(size);
    g_regions[region].align = align;
    g_regions[region].reserved = true;
    g_arena_used = static_cast<uint32_t>(end);
    return base;
}

extern "C" SwArenaRange sw_arena_range(uint32_t region) {
    SwArenaRange out = {0, 0, region, 0};
    if (region == 0 || region >= SW_REGION_COUNT || !g_regions[region].reserved) {
        return out;
    }
    out.offset = g_regions[region].offset;
    out.size = g_regions[region].size;
    out.flags = SW_ARENA_F_READ | SW_ARENA_F_WRITE | SW_ARENA_F_SHARED;
    return out;
}

extern "C" void *sw_arena_ptr(uint32_t offset) {
    if (g_arena == nullptr || offset >= g_arena_bytes) {
        return nullptr;
    }
    return g_arena + offset;
}

extern "C" uint32_t sw_arena_size(void) { return g_arena_bytes; }
extern "C" uint32_t sw_arena_used(void) { return g_arena_used; }

extern "C" uint32_t sw_arena_write_region_table(void *out, uint32_t out_capacity) {
    const uint32_t needed = (uint32_t)sizeof(SwArenaRange) * SW_REGION_COUNT;
    if (out == nullptr || out_capacity < needed) {
        return 0;
    }
    SwArenaRange *dst = static_cast<SwArenaRange *>(out);
    for (uint32_t r = 0; r < SW_REGION_COUNT; ++r) {
        dst[r] = sw_arena_range(r);
    }
    return needed;
}

// Grows the arena in place by extending the allocation with realloc.
//
// Under Emscripten with ALLOW_MEMORY_GROWTH this can move the base pointer, so
// the exported memory buffer detaches and every JS-side view becomes invalid.
// Callers in JS must re-derive their views after any call to this function.
// Growth is the reason Part 7 risk 4 calls for an explicit, tested protocol.
extern "C" uint32_t sw_arena_grow(uint32_t delta_bytes) {
    if (g_arena == nullptr || delta_bytes == 0) {
        return g_arena_bytes;
    }
    const uint64_t want = static_cast<uint64_t>(g_arena_bytes) + delta_bytes;
    const uint32_t target = want > SW_ARENA_MAX_BYTES ? SW_ARENA_MAX_BYTES
                                                      : static_cast<uint32_t>(want);
    if (target <= g_arena_bytes) {
        return g_arena_bytes;
    }

    uint8_t *next = static_cast<uint8_t *>(realloc(g_arena, target));
    if (next == nullptr) {
        return g_arena_bytes;  // unchanged; caller keeps working
    }
    memset(next + g_arena_bytes, 0, target - g_arena_bytes);
    g_arena = next;
    g_arena_bytes = target;
    return g_arena_bytes;
}
