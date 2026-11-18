// Host-facing layer: builds ready-to-play instruments (kits or single builds) from the shared preset format.
// Building is slow (models + loudness calibration) and runs off the audio thread; playing is real-time safe.
#pragma once
#include "dh_drum.h"
#include <memory>
#include <string>
#include <vector>

namespace dh {

constexpr const char* kVersion = "0.2.0";

struct Pad { int note; std::string label; };

struct Instrument {
    std::string name; bool isKit = false; double sr = 48000;
    std::unique_ptr<Kit> kit;            // kit mode
    std::unique_ptr<Player> player;      // single-build mode
    Json source;                         // the kit / build JSON it came from (saved with the project)
    std::vector<Pad> pads;               // for the UI: playable notes and what they hit

    void noteOn(int note, double vel);
    void noteOff(int note);
    void hatPedal(double down);          // 0 = foot up (open), 1 = pressed shut
    void process(float* L, float* R, int n);
};

// Kit JSON as in reference/kits.json: { name, pieces: [{ name, cfg, level, pan }], map: { note: slot }, mix }
std::unique_ptr<Instrument> buildKit(const Json& kit, double sr);

} // namespace dh
