// core/test/unit/test_main.cpp
// SPDX-License-Identifier: MIT

#include "test_harness.h"

#include <stdlib.h>

namespace swtest {
namespace {

constexpr int kMaxTests = 128;
TestCase g_tests[kMaxTests];
int g_test_count = 0;

}  // namespace

TestCase* registry() { return g_tests; }
int registry_count() { return g_test_count; }

void register_test(const char* name, void (*fn)()) {
    if (g_test_count >= kMaxTests) {
        fprintf(stderr, "test registry overflow\n");
        abort();
    }
    g_tests[g_test_count].name = name;
    g_tests[g_test_count].fn = fn;
    g_test_count++;
}

}  // namespace swtest

int main(int argc, char** argv) {
    const char* filter = (argc > 1) ? argv[1] : nullptr;

    int ran = 0;
    for (int i = 0; i < swtest::registry_count(); ++i) {
        if (filter != nullptr && strstr(swtest::registry()[i].name, filter) == nullptr) {
            continue;
        }
        swtest::g_current = swtest::registry()[i].name;
        const int before = swtest::g_failures;
        swtest::registry()[i].fn();
        ++ran;
        const bool ok = swtest::g_failures == before;
        printf("[%s] %s\n", ok ? "PASS" : "FAIL", swtest::g_current);
    }

    printf("\n%d test(s), %d check(s), %d failure(s)\n", ran, swtest::g_checks,
           swtest::g_failures);
    return swtest::g_failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
