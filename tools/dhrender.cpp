// Headless render / self-test tool.
//   dhrender --selftest      run engine sanity checks (used by CI)
// Later: dhrender --groove out.wav  renders the Studio kit groove for comparison
// with reference/studio_kit_groove.wav.
#include "dh_engine.h"
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

int main(int argc, char** argv)
{
    bool selftest = argc > 1 && std::strcmp(argv[1], "--selftest") == 0;
    dh::Engine e;
    e.prepare(48000.0, 512);
    std::vector<float> L(512), R(512);
    e.noteOn(36, 0.85f);
    for (int b = 0; b < 100; ++b) {
        e.process(L.data(), R.data(), 512);
        for (int i = 0; i < 512; ++i)
            if (!std::isfinite(L[i]) || !std::isfinite(R[i])) { std::printf("FAIL: non-finite output\n"); return 1; }
    }
    std::printf("dhrender %s: %s OK\n", dh::kVersion, selftest ? "selftest" : "render");
    return 0;
}
