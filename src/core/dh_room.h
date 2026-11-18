// The studio live-room impulse response used by the builder page (app.js makeIR), and the bus pieces the page
// built from Web Audio nodes: room high-pass, wet/dry, master and the last-resort soft clip.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace dh {

// Two channels, already scaled as a Web Audio ConvolverNode (normalize = true) would scale them.
inline std::vector<std::vector<float>> makeRoomIR(double sr, double rt = 0.9)
{
    const double PI_ = 3.141592653589793;
    int n = (int) std::floor(sr * rt * 1.25 + 0.5);
    std::vector<std::vector<float>> d(2, std::vector<float>((size_t) n, 0.f));
    uint32_t seed = 99;
    auto rnd = [&]() { seed = seed * 1664525u + 1013904223u; return seed / 2147483648.0 - 1; };
    int pre = (int) std::floor(0.007 * sr + 0.5);
    const double fc[4] = { 300, 2500, 7000, 16000 }, brt[4] = { rt * 1.15, rt, rt * 0.55, rt * 0.28 };
    for (int ch = 0; ch < 2; ch++) {
        double lp[4] = { 0, 0, 0, 0 };
        for (int i = pre; i < n; i++) {
            double t = (double) (i - pre) / sr, x = rnd(), y = 0, lo = 0;
            for (int k = 0; k < 4; k++) {
                double g = 1 - std::exp(-2 * PI_ * fc[k] / sr); lp[k] += g * (x - lp[k]);
                double band = lp[k] - lo; lo = lp[k];
                y += band * std::exp(-6.91 * t / brt[k]);
            }
            double fade = std::min(1.0, t / 0.035);
            d[ch][(size_t) i] = (float) (y * fade * fade * 0.55);
        }
        for (int e = 0; e < 18; e++) {
            double r1 = rnd(); double dly = 0.004 + 0.045 * std::pow((e + 0.5 + 0.4 * r1) / 18, 1.3);
            if (ch) dly += 0.0011 * rnd();
            int idx = pre + (int) std::floor(dly * sr + 0.5);
            double r2 = rnd(); double sg = r2 < 0 ? -1 : 1; double r3 = rnd();
            double amp = 0.9 * std::pow(0.82, e) * sg * (0.7 + 0.3 * std::fabs(r3));
            for (int j = 0; j < 24 && idx + j < n; j++) d[ch][(size_t) (idx + j)] = (float) (d[ch][(size_t) (idx + j)] + amp * std::exp(-j / 4.0) * (j ? 0.35 : 1));
        }
    }
    double E = 0; for (auto& c : d) for (float v : c) E += (double) v * v;
    double k2 = 1 / std::sqrt(E / 2);
    for (auto& c : d) for (auto& v : c) v = (float) (v * k2 * 0.6);
    // ConvolverNode normalisation (Web Audio spec: equal-power, calibrated to 0.00125 at 44.1 kHz)
    double P = 0; for (auto& c : d) for (float v : c) P += (double) v * v;
    double power = std::sqrt(P / (2.0 * n)); if (!(power >= 0.000125)) power = 0.000125;
    double scale = 1 / power * 0.00125 * 44100 / sr;
    for (auto& c : d) for (auto& v : c) v = (float) (v * scale);
    return d;
}

// Web Audio biquad high-pass (its Q is in dB for high/low-pass).
struct Biquad {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    void highpass(double sr, double f, double qDb)
    {
        double w0 = 2 * 3.141592653589793 * f / sr, al = std::sin(w0) / (2 * std::pow(10.0, qDb / 20)), cw = std::cos(w0), a0 = 1 + al;
        b0 = (1 + cw) / 2 / a0; b1 = -(1 + cw) / a0; b2 = (1 + cw) / 2 / a0; a1 = -2 * cw / a0; a2 = (1 - al) / a0;
    }
    float run(float x) { double y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return (float) y; }
    void reset() { z1 = z2 = 0; }
};

// the page's last-resort clip: transparent below about -1.4 dBFS, never above 0.96
inline float softClip(float x)
{
    float ax = std::fabs(x), k = 0.85f, top = 0.96f;
    return ax <= k ? x : (x > 0 ? 1.f : -1.f) * (k + (top - k) * std::tanh((ax - k) / (top - k)));
}

} // namespace dh
