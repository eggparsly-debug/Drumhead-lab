#pragma once
#include "dh_drum.h"
#include <functional>

namespace dh {

struct MicW { std::vector<double> L, R; double cL = 0, cR = 0, oh = 0; };
MicW micWeights(const std::vector<const Mode*>& modes, const std::function<double(const Mode&, double, double)>& shapeFn, const Json& mics, const std::vector<double>* outWs);

double cymEq(double f, const std::string& piece);

} // namespace dh
