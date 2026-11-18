// Shared constants and JavaScript-semantics helpers for the engine port.
#pragma once
#include <cmath>
#include <cstdint>

namespace dh {

constexpr double PI = 3.141592653589793;
constexpr double TAU = 2 * PI;
constexpr double RHO = 1.2, C = 343, NU = 0.35;
constexpr double QB = 0, CHICK = 25, TAUMET = 0.2, RESK = 400, RINGK = 2500;
constexpr int MMAX = 10, NMAX = 7, NPROXY = 36, RTAB = 256;

// Math.max / Math.min (NaN-propagating, like JavaScript)
inline double jmax(double a, double b) { if (a != a || b != b) return NAN; return a > b ? a : b; }
inline double jmin(double a, double b) { if (a != a || b != b) return NAN; return a < b ? a : b; }
// Math.round
inline double jsround(double x) { return std::floor(x + 0.5); }
// x | 0
inline int32_t toInt32(double x)
{
    if (!(x == x) || std::isinf(x)) return 0;
    double t = std::trunc(x); double m = std::fmod(t, 4294967296.0); if (m < 0) m += 4294967296.0;
    return (int32_t) (uint32_t) m;
}
inline double hashf(double m, double n) { double s = std::sin(m * 12.9898 + n * 78.233) * 43758.5453; return s - std::floor(s); }
// (seed * 1664525 + 1013904223) >>> 0
inline uint32_t lcg(uint32_t s) { return s * 1664525u + 1013904223u; }
// x ^= x << 13; x ^= x >> 17; x ^= x << 5   (on int32, as JavaScript does)
inline int32_t xorshift(int32_t x)
{
    x ^= (int32_t) ((uint32_t) x << 13); x ^= (x >> 17); x ^= (int32_t) ((uint32_t) x << 5); return x;
}

double metalShape(const struct Mode& md, double r, double th);

} // namespace dh
