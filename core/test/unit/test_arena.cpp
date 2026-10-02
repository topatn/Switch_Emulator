// core/test/unit/test_arena.cpp
// SPDX-License-Identifier: MIT
//
// Arena tests. The region-table format is part of the ABI, and the "guest RAM
// is not resident, only reserved" property (Part 3.3) is the thing that keeps
// a 14 GB install from becoming a 14 GB allocation, so it is worth asserting
// rather than assuming.

#include "core/memory.h"
#include "test_harness.h"

SW_TEST(arena_reserves_every_region_in_order) {
    sw_arena_init(0);
    SW_CHECK(sw_arena_size() > 0);

    uint32_t prev_end = 0;
    for (uint32_t r = 1; r < SW_REGION_COUNT; ++r) {
        const SwArenaRange range = sw_arena_range(r);
        SW_CHECK(range.size > 0);
        SW_CHECK(range.offset != 0);
        SW_CHECK(range.offset >= prev_end);
        SW_CHECK(range.flags & SW_ARENA_F_SHARED);
        prev_end = range.offset + range.size;
    }
    SW_CHECK(prev_end <= sw_arena_size());

    sw_arena_shutdown();
}

SW_TEST(arena_rejects_out_of_bounds_pointer) {
    sw_arena_init(0);
    SW_CHECK(sw_arena_ptr(0) != nullptr);
    SW_CHECK(sw_arena_ptr(sw_arena_size()) == nullptr);
    SW_CHECK(sw_arena_ptr(sw_arena_size() + 4096u) == nullptr);
    sw_arena_shutdown();
}

SW_TEST(arena_reservation_is_idempotent_and_region_scoped) {
    sw_arena_init(0);

    const SwArenaRange before = sw_arena_range(SW_REGION_HID_STATE);
    const uint32_t again = sw_arena_reserve(SW_REGION_HID_STATE, 1024, 16);
    SW_CHECK_EQ(again, before.offset);

    // A second reservation of the same region must not consume arena space.
    const SwArenaRange after = sw_arena_range(SW_REGION_HID_STATE);
    SW_CHECK_EQ(after.offset, before.offset);
    SW_CHECK_EQ(after.size, before.size);

    SW_CHECK_EQ(sw_arena_reserve(SW_REGION_RESERVED, 64, 16), SW_NULL_HANDLE);
    SW_CHECK_EQ(sw_arena_reserve(SW_REGION_COUNT, 64, 16), SW_NULL_HANDLE);
    SW_CHECK_EQ(sw_arena_reserve(SW_REGION_NVN_RING, 0, 16), SW_NULL_HANDLE);

    sw_arena_shutdown();
}

SW_TEST(arena_clamps_and_caps_size) {
    sw_arena_init(SW_ARENA_MAX_BYTES * 4u);
    SW_CHECK(sw_arena_size() <= SW_ARENA_MAX_BYTES);
    sw_arena_shutdown();

    // A tiny arena cannot hold the default region set; reservations must fail
    // cleanly rather than scribbling past the end.
    sw_arena_init(4096);
    SW_CHECK(sw_arena_reserve(SW_REGION_GUEST_RAM, 64u * 1024u * 1024u, 16) ==
             SW_NULL_HANDLE);
    sw_arena_shutdown();
}

SW_TEST(arena_grow_preserves_contents_and_reports_new_size) {
    sw_arena_init(0);
    const uint32_t before = sw_arena_size();

    auto* data = static_cast<uint8_t*>(sw_arena_ptr(0));
    data[0] = 0xAB;
    data[before - 1] = 0xCD;

    const uint32_t after = sw_arena_grow(1024u * 1024u);
    SW_CHECK(after >= before);

    // The base pointer may have moved, so re-derive rather than reusing.
    auto* grown = static_cast<uint8_t*>(sw_arena_ptr(0));
    SW_CHECK_EQ(grown[0], 0xAB);
    SW_CHECK_EQ(grown[after - 1], 0x00);  // new bytes are zeroed
    SW_CHECK_EQ(grown[before - 1], 0xCD);

    sw_arena_shutdown();
}

SW_TEST(region_table_serializes_to_a_stable_size) {
    sw_arena_init(0);
    const uint32_t needed = static_cast<uint32_t>(sizeof(SwArenaRange)) * SW_REGION_COUNT;

    SwArenaRange table[SW_REGION_COUNT];
    SW_CHECK_EQ(sw_arena_write_region_table(table, sizeof(table)), needed);

    // An undersized output buffer must write nothing at all.
    SW_CHECK_EQ(sw_arena_write_region_table(table, needed - 1u), 0);
    SW_CHECK_EQ(sw_arena_write_region_table(nullptr, needed), 0);

    sw_arena_shutdown();
}
