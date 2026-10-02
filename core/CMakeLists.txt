// core/CMakeLists.txt
// Two builds from one source tree (Part 4.1: "Same source, two builds is the
// cheapest correctness net"):
//
//   emcmake cmake -S core -B core/build -DSW_BUILD_WASM=ON && cmake --build core/build
//       -> core/build/switch_core.wasm
//   cmake -S core -B core/build-host
//       -> host unit tests under core/test/unit
//
// Part 5 note: the core is the source of truth, so CMakeLists.txt is the build
// manifest rather than a hand-maintained list.

cmake_minimum_required(VERSION 3.20)
project(switch_web_core CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(SW_BUILD_WASM "Build the WebAssembly core" OFF)
option(SW_BUILD_TESTS "Build the host-native test suite" OFF)

add_library(switch_core STATIC
    src/platform/init.cpp
    src/memory/arena.cpp
)
target_include_directories(switch_core PUBLIC include)
target_compile_options(switch_core PRIVATE -Wall -Wextra -Wpedantic)

# ---------------------------------------------------------------------------
# Host test build
# ---------------------------------------------------------------------------
if(SW_BUILD_TESTS)
    enable_testing()
    add_executable(sw_unit_tests
        test/unit/test_main.cpp
        test/unit/test_arena.cpp
        test/unit/test_abi.cpp
    )
    target_link_libraries(sw_unit_tests PRIVATE switch_core)
    target_compile_features(sw_unit_tests PRIVATE cxx_std_20)
    add_test(NAME sw_unit_tests COMMAND sw_unit_tests)
endif()

# ---------------------------------------------------------------------------
# WebAssembly build
#
# Part 4.1 flags, with the reasoning that matters:
#
#   -sSHARED_MEMORY           required. Guest RAM is a SharedArrayBuffer shared
#                             with the GPU/audio/IO workers, and the whole
#                             emulator is predicated on cross-origin isolation.
#   -sALLOW_MEMORY_GROWTH     the arena grows (Part 3.3). Growth detaches the
#                             exported buffer, which is why sw_arena_grow is
#                             documented as a view-invalidation event.
#   -msimd128                 a hard requirement for v1, not an optimisation:
#                             it backs FPSIMD/NEON translation and the hot
#                             memory-move helpers in the JIT (Part 3.2.3).
#   -mtail-call               guest stacks are deep (Part 3.2.3); without tail
#                             calls a WASM-hosted guest stack overflows.
#   -mbulk-memory -msign-ext -mnontrapping-fptoint
#                             post-MVP features the JIT output depends on.
#
# Verify flag spelling against the installed Emscripten version; these move
# between releases. tools/build-core.mjs fails loudly if a flag is rejected
# rather than silently dropping the feature.
# ---------------------------------------------------------------------------
if(SW_BUILD_WASM)
    if(NOT EMSCRIPTEN)
        message(FATAL_ERROR
            "SW_BUILD_WASM=ON requires an Emscripten toolchain. "
            "Run via: emcmake cmake -S core -B core/build -DSW_BUILD_WASM=ON")
    endif()

    set(SW_FEATURES "-msimd128,-mbulk-memory,-msign-ext,-mnontrapping-fptoint")
    include(CheckCXXCompilerFlag)
    check_cxx_compiler_flag("-mtail-call" SW_HAS_TAIL_CALL)
    if(SW_HAS_TAIL_CALL)
        set(SW_FEATURES "${SW_FEATURES},-mtail-call")
        set(SW_DEFINES "${SW_DEFINES} SW_FEATURE_TAIL_CALL_BUILD=1")
    endif()

    set(SW_EXPORTED_FUNCTIONS
        "[\"_malloc\",\"_free\","
        "\"_sw_abi_version\",\"_sw_core_features\",\"_sw_core_build_id\","
        "\"_sw_core_init\",\"_sw_core_shutdown\",\"_sw_core_state\","
        "\"_sw_core_arena_ptr\",\"_sw_core_arena_size\",\"_sw_core_arena_used\","
        "\"_sw_core_region_table\",\"_sw_core_telemetry_offset\","
        "\"_sw_core_telemetry_refresh\",\"_sw_core_ping\","
        "\"_sw_core_monotonic_ns\",\"_sw_core_note_roundtrip\","
        "\"_sw_arena_grow\","
        "\"_sw_emscripten_bootstrap\",\"_sw_emscripten_is_ready\",\"_sw_emscripten_log\","
        "\"_sw_worker_arena_bytes\",\"_sw_worker_boot\",\"_sw_worker_quit\","
        "\"_malloc\",\"_free\"]")

    add_executable(switch_core.wasm wasm/exports.cpp wasm/workers.cpp)
    target_link_libraries(switch_core.wasm PRIVATE switch_core)
    target_compile_definitions(switch_core.wasm PRIVATE
        SW_BUILD_ID="\"${SW_BUILD_ID}\"" SW_SHARED_MEMORY_BUILD=1)

    set_target_properties(switch_core.wasm PROPERTIES
        OUTPUT_NAME "switch_core"
        SUFFIX ".wasm")

    target_link_options(switch_core.wasm PRIVATE
        ${SW_FEATURES}
        "-O3"
        "-flto"
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sENVIRONMENT=web,worker"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sINITIAL_MEMORY=67108864"
        "-sSTACK_SIZE=1048576"
        "-sSHARED_MEMORY=1"
        "-sPTHREAD_POOL_SIZE=4"
        "-sPTHREADS=1"
        "-sEXPORTED_FUNCTIONS=${SW_EXPORTED_FUNCTIONS}"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32','HEAPU64','HEAPF64','HEAP32','HEAP16','wasmMemory']"
        "-sINCOMING_MODULE_JS_API=['locateFile','wasmMemory','instantiateWasm','print','printErr']"
        "-sASSERTIONS=0"
        "-sDISABLE_EXCEPTION_CATCHING=1"
        "-sDYNAMIC_EXECUTION=0"
        "-sTEXTDECODER=1"
        "-sFILESYSTEM=0"
    )
endif()
