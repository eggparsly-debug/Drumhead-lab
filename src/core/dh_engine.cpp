#include "dh_engine.h"
#include <cstring>

namespace dh {

void Engine::prepare(double sampleRate, int) { sr = sampleRate; }
void Engine::noteOn(int, float) {}
void Engine::noteOff(int) {}
void Engine::controller(int, float) {}
void Engine::process(float* left, float* right, int n)
{
    std::memset(left, 0, sizeof(float) * (size_t) n);
    std::memset(right, 0, sizeof(float) * (size_t) n);
}

} // namespace dh
