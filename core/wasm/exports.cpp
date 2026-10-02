// core/wasm/exports.cpp
// SPDX-License-Identifier: MIT
//
// Emscripten entry glue.
//
// The C ABI is declared in core/include/core/platform.h and implemented in
// core/src/platform/init.cpp. Emscripten exports it with EXPORTED_FUNCTIONS
// in core/CMakeLists.txt, so the only work here is the JS-facing extras that
// have no C equivalent: an explicit module-initialisation hook that runs before
// any guest work, and the per-worker entry points the TS shell calls.
//
// Part 4.1 keeps this file deliberately thin: no emulation logic, no state.
// "Keep the ABI surface tiny and explicit; avoid embind overhead in hot paths."

#include "core/memory.h"
#include "core/platform.h"

#include <emscripten/emscripten.h>

namespace {

bool g_emscripten_ready = false;

}  // namespace

// Called once per worker instance, immediately after instantiation and before
// any other exported call. Workers are independent processes in the emulator's
// model (Part 3.9), so each needs its own arena; nothing here is shared
// implicitly.
extern "C" {

EMSCRIPTEN_KEEPALIVE
int sw_emscripten_bootstrap(uint32_t arena_bytes) {
    if (g_emscripten_ready) {
        return SW_OK;
    }
    const int32_t rc = sw_core_init(arena_bytes);
    g_emscripten_ready = (rc == SW_OK);
    return rc;
}

EMSCRIPTEN_KEEPALIVE
uint32_t sw_emscripten_is_ready(void) {
    return g_emscripten_ready ? 1u : 0u;
}

// Logs a line through emscripten's stderr, which the shell surfaces in the
// diagnostics overlay. Used for the once-per-unknown-command logging the HLE
// layer depends on (Part 3.4) and for boot breadcrumbs.
EMSCRIPTEN_KEEPALIVE
void sw_emscripten_log(const char *message) {
    if (message == nullptr) {
        return;
    }
    emscripten_console_log(message);
}

}  // extern "C"
