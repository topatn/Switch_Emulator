// core/src/platform/init.cpp
// SPDX-License-Identifier: MIT
//
// Core lifecycle, identity, and the Phase 0 gate helpers (Part 6, Phase 0).

#include "core/memory.h"
#include "core/platform.h"

#include <string.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#else
#include <chrono>
#endif

#ifndef SW_BUILD_ID
#define SW_BUILD_ID "switch-web core (unidentified build)"
#endif

namespace {

enum CoreState : uint32_t {
    kStateCold = 0,
    kStateReady = 1,
    kStateShutdown = 2,
};

CoreState g_state = kStateCold;
uint64_t   g_boot_ns = 0;
uint64_t   g_last_ping_ns = 0;
uint64_t   g_last_roundtrip_ns = 0;

SwCoreTelemetry *telemetry() {
    const SwArenaRange r = sw_arena_range(SW_REGION_TELEMETRY);
    if (!r.size) {
        return nullptr;
    }
    return static_cast<SwCoreTelemetry *>(sw_arena_ptr(r.offset));
}

}  // namespace

extern "C" uint32_t sw_abi_version(void) { return SW_ABI_VERSION; }

extern "C" uint32_t sw_core_features(void) {
    uint32_t f = 0;
#if defined(__wasm_simd128__)
    f |= SW_FEATURE_SIMD128;
#endif
#if defined(__wasm_bulk_memory__)
    f |= SW_FEATURE_BULK_MEMORY;
#endif
#if defined(__wasm_tail_call__)
    f |= SW_FEATURE_TAIL_CALL;
#endif
#if defined(__wasm_sign_ext__)
    f |= SW_FEATURE_SIGN_EXT;
#endif
#if defined(__EMSCRIPTEN__) && defined(SW_SHARED_MEMORY_BUILD)
    f |= SW_FEATURE_SHARED_MEMORY;
#endif
    return f;
}

extern "C" const char *sw_core_build_id(void) { return SW_BUILD_ID; }

extern "C" int32_t sw_core_init(uint32_t arena_bytes) {
    if (g_state == kStateReady) {
        sw_core_telemetry_refresh();
        return SW_OK;
    }

    g_boot_ns = sw_core_monotonic_ns();
    sw_arena_init(arena_bytes);

    if (sw_arena_size() == 0) {
        g_state = kStateCold;
        return SW_ERR_OUT_OF_MEMORY;
    }

    g_state = kStateReady;
    sw_core_telemetry_refresh();
    return SW_OK;
}

extern "C" void sw_core_shutdown(void) {
    sw_arena_shutdown();
    g_state = kStateShutdown;
}

extern "C" uint32_t sw_core_state(void) { return static_cast<uint32_t>(g_state); }

extern "C" uint32_t sw_core_arena_ptr(void) {
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(sw_arena_ptr(0)));
}

extern "C" uint32_t sw_core_arena_size(void) { return sw_arena_size(); }
extern "C" uint32_t sw_core_arena_used(void) { return sw_arena_used(); }

extern "C" uint32_t sw_core_region_table(void *out, uint32_t out_capacity) {
    return sw_arena_write_region_table(out, out_capacity);
}

extern "C" uint32_t sw_core_telemetry_offset(void) {
    return sw_arena_range(SW_REGION_TELEMETRY).offset;
}

extern "C" void sw_core_telemetry_refresh(void) {
    SwCoreTelemetry *t = telemetry();
    if (t == nullptr) {
        return;
    }
    t->abi_version = SW_ABI_VERSION;
    t->init_state = static_cast<uint32_t>(g_state);
    t->boot_ticks_ns = g_boot_ns;
    t->arena_bytes = sw_arena_size();
    t->ring_capacity = sw_arena_range(SW_REGION_NVN_RING).size;
    t->last_roundtrip_ns = g_last_roundtrip_ns;
}

extern "C" void sw_core_note_roundtrip(uint64_t elapsed_ns) {
    g_last_roundtrip_ns = elapsed_ns;
    sw_core_telemetry_refresh();
}

extern "C" int32_t sw_core_ping(int32_t value) {
    // Deliberately read the telemetry block: the round-trip gate is only
    // meaningful if the core really executed and touched shared memory.
    g_last_ping_ns = sw_core_monotonic_ns();
    SwCoreTelemetry *t = telemetry();
    if (t != nullptr && t->abi_version != SW_ABI_VERSION) {
        return SW_ERR_INVALID_ARG;
    }
    return value;
}

extern "C" uint64_t sw_core_monotonic_ns(void) {
#if defined(__EMSCRIPTEN__)
    return static_cast<uint64_t>(emscripten_get_now()) * 1000000ull;
#else
    // Host test build. std::chrono keeps this portable to MSVC, which has no
    // clock_gettime. The web build never sees <chrono>.
    using clock = std::chrono::steady_clock;
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            clock::now().time_since_epoch()).count());
#endif
}
