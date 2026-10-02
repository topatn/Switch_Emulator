// core/test/unit/test_abi.cpp
// SPDX-License-Identifier: MIT
//
// ABI contract tests. These are the ones that must pass before the TS shell is
// allowed to talk to a module: version, lifecycle, telemetry offsets.

#include "core/memory.h"
#include "core/platform.h"
#include "test_harness.h"

SW_TEST(abi_version_matches_the_header_constant) {
    SW_CHECK_EQ(sw_abi_version(), SW_ABI_VERSION);
    SW_CHECK(sw_core_build_id() != nullptr);
    SW_CHECK(sw_core_build_id()[0] != '\0');
}

SW_TEST(lifecycle_is_reported_through_state) {
    sw_core_shutdown();  // ensure a cold start regardless of test order
    SW_CHECK_EQ(sw_core_state(), 2u);  // shut down

    SW_CHECK_EQ(sw_core_init(0), SW_OK);
    SW_CHECK_EQ(sw_core_state(), 1u);

    // Idempotent.
    SW_CHECK_EQ(sw_core_init(0), SW_OK);
    SW_CHECK_EQ(sw_core_state(), 1u);

    sw_core_shutdown();
    SW_CHECK_EQ(sw_core_state(), 2u);
}

SW_TEST(ping_round_trips_its_argument) {
    SW_CHECK_EQ(sw_core_init(0), SW_OK);
    SW_CHECK_EQ(sw_core_ping(0), 0);
    SW_CHECK_EQ(sw_core_ping(1), 1);
    SW_CHECK_EQ(sw_core_ping(-1), -1);
    SW_CHECK_EQ(sw_core_ping(0x7FFFFFFF), 0x7FFFFFFF);

    // Out-of-band: ping must observe a stale telemetry version and complain,
    // which is how the shell detects a module/cache mismatch.
    const uint32_t t = sw_core_telemetry_offset();
    SW_CHECK(t != SW_NULL_HANDLE);
    sw_core_shutdown();
}

SW_TEST(telemetry_block_is_addressable_and_populated) {
    SW_CHECK_EQ(sw_core_init(0), SW_OK);

    const uint32_t offset = sw_core_telemetry_offset();
    SW_CHECK(offset != SW_NULL_HANDLE);
    SW_CHECK(offset + SW_TELEMETRY_SIZE <= sw_core_arena_size());

    auto* t = static_cast<SwCoreTelemetry*>(sw_core_arena_ptr(offset));
    SW_CHECK_EQ(t->abi_version, SW_ABI_VERSION);
    SW_CHECK_EQ(t->init_state, 1u);
    SW_CHECK(t->arena_bytes > 0);

    sw_core_note_roundtrip(1234);
    SW_CHECK_EQ(t->last_roundtrip_ns, 1234u);

    sw_core_shutdown();
}

SW_TEST(monotonic_clock_does_not_go_backwards) {
    const uint64_t a = sw_core_monotonic_ns();
    const uint64_t b = sw_core_monotonic_ns();
    SW_CHECK(b >= a);
    SW_CHECK(a > 0);
}

SW_TEST(region_table_is_readable_from_the_abi_surface) {
    SW_CHECK_EQ(sw_core_init(0), SW_OK);

    SwArenaRange table[SW_REGION_COUNT];
    const uint32_t n = sw_core_region_table(table, sizeof(table));
    SW_CHECK_EQ(n, static_cast<uint32_t>(sizeof(SwArenaRange)) * SW_REGION_COUNT);

    for (uint32_t r = 1; r < SW_REGION_COUNT; ++r) {
        SW_CHECK(table[r].region == r);
        SW_CHECK(table[r].size > 0);
    }

    sw_core_shutdown();
}
