// core/test/unit/test_harness.h
// SPDX-License-Identifier: MIT
//
// A ~60 line test harness rather than a vendored gtest. Part 6 treats the host
// test suite as a Phase 0/1 gate, so it has to build in CI with no network
// fetch of dependencies; a single header keeps that true until the project
// decides to vendor gtest deliberately.

#ifndef CORE_TEST_HARNESS_H
#define CORE_TEST_HARNESS_H

#include <stdio.h>
#include <string.h>

namespace swtest {

inline int g_failures = 0;
inline int g_checks = 0;
inline const char* g_current = "";

inline void report_fail(const char* file, int line, const char* expr,
                        const char* detail) {
    g_failures++;
    fprintf(stderr, "  FAIL %s\n    %s:%d: %s\n", g_current, file, line, expr);
    if (detail != nullptr && detail[0] != '\0') {
        fprintf(stderr, "    detail: %s\n", detail);
    }
}

#define SW_CHECK(expr)                                                        \
    do {                                                                      \
        swtest::g_checks++;                                                   \
        if (!(expr)) {                                                        \
            swtest::report_fail(__FILE__, __LINE__, #expr, "");               \
        }                                                                     \
    } while (0)

#define SW_CHECK_EQ(actual, expected)                                         \
    do {                                                                      \
        swtest::g_checks++;                                                   \
        const auto sw_a = (actual);                                           \
        const auto sw_e = (expected);                                         \
        if (!(sw_a == sw_e)) {                                                \
            char buf[128];                                                    \
            snprintf(buf, sizeof(buf), "got %lld, want %lld",                 \
                     static_cast<long long>(sw_a),                            \
                     static_cast<long long>(sw_e));                           \
            swtest::report_fail(__FILE__, __LINE__, #actual " == " #expected, \
                                buf);                                         \
        }                                                                     \
    } while (0)

struct TestCase {
    const char* name;
    void (*fn)();
};

inline TestCase* registry();
inline int registry_count();
inline void register_test(const char* name, void (*fn)());

struct Registrar {
    Registrar(const char* name, void (*fn)()) { register_test(name, fn); }
};

#define SW_TEST(name)                                                         \
    static void name();                                                       \
    static ::swtest::Registrar sw_reg_##name(#name, &name);                   \
    static void name()

}  // namespace swtest

#endif  // CORE_TEST_HARNESS_H
