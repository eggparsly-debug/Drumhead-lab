// Drumhead Lab sound engine (C++ port of reference/engine.js).
// Plain C++17, no JUCE. Real-time safe after prepare(): no allocation in process().
#pragma once
#include <cstdint>

namespace dh {

constexpr const char* kVersion = "0.1.0-scaffold";

// Placeholder kit player: the full modal engine port lands here next.
// The interface matches how the plugin will drive it.
class Engine {
public:
    void prepare(double sampleRate, int maxBlock);
    void noteOn(int note, float velocity);   // velocity 0..1
    void noteOff(int note);
    void controller(int cc, float value);    // value 0..1
    void process(float* left, float* right, int numSamples);

private:
    double sr = 48000.0;
};

} // namespace dh
