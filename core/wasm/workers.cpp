// core/wasm/workers.cpp
// SPDX-License-Identifier: MIT
//
// Per-worker entrypoints (Part 5 lists this file; Part 3.9 defines the topology).
//
// Each worker hosts its own instance of the core. Today that instance only owns
// its arena and the telemetry block; the CPU worker will additionally own guest
// RAM, the GPU worker the WebGPU device, and so on. Keeping one entry point per
// worker, with an explicit arena size, means a worker's memory footprint is
// declared in one place rather than inferred from what it happens to touch.

#include "core/memory.h"
#include "core/platform.h"

#include <emscripten/emscripten.h>

namespace {

// Arena sizes per worker, in MiB. Sized to the Part 3.9 shared-memory region
// list, minus what each worker does not need.
constexpr uint32_t kArenaMiB = 1024u * 1024u;

uint32_t arena_bytes_for(const char *worker) {
    if (worker == nullptr) {
        return 256u * kArenaMiB;
    }
    const char* w = worker;
    if (strstr(w, "cpu") != nullptr) {
        return 1024u * kArenaMiB;  // owns guest RAM + TLB + CPU contexts
    }
    if (strstr(w, "gpu") != nullptr) {
        return 512u * kArenaMiB;   // owns render targets + NVN ring
    }
    if (strstr(w, "audio") != nullptr) {
        return 128u * kArenaMiB;  // owns the audren PCM ring
    }
    if (strstr(w, "io") != nullptr) {
        return 256u * kArenaMiB;   // save data, save states, block reader
    }
    return 256u * kArenaMiB;
}

}  // namespace

extern "C" {

// Returns the arena size this worker will request, so the shell can log the
// memory plan before allocating anything.
EMSCRIPTEN_KEEPALIVE
uint32_t sw_worker_arena_bytes(const char *worker) {
    return arena_bytes_for(worker);
}

// Boots the worker: initialises the core with the worker's arena size and
// returns the resulting status.
EMSCRIPTEN_KEEPALIVE
int32_t sw_worker_boot(const char *worker) {
    return sw_core_init(arena_bytes_for(worker));
}

EMSCRIPTEN_KEEPALIVE
void sw_worker_quit(const char *worker) {
    (void)worker;
    sw_core_shutdown();
}

}  // extern "C"
