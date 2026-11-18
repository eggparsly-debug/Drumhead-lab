#include "dh_engine.h"
#include <algorithm>

namespace dh {

std::unique_ptr<Instrument> buildKit(const Json& K, double sr)
{
    auto inst = std::make_unique<Instrument>();
    inst->isKit = true; inst->sr = sr; inst->name = K.str("name"); inst->source = K;
    inst->kit = std::make_unique<Kit>(sr);
    const Json& pcs = K.get("pieces");
    for (size_t i = 0; i < pcs.size(); i++) {
        const Json& pc = pcs.at(i);
        Json c = pc.get("cfg"); c.set("lite", Json::boolean(true));   // kit CPU saver, as in the browser
        auto m = buildModel(c, sr); calibrate(*m, sr);
        double lv = pc.num("level"), pn = pc.num("pan");
        inst->kit->setPiece((int) i, m, pc.get("level").isNullish() ? nullptr : &lv, pc.get("pan").isNullish() ? nullptr : &pn);
    }
    auto map = parseKitMap(K.get("map"));
    inst->kit->setMap(map);
    const Json& mix = K.get("mix");
    inst->kit->punch = mix.nn("punch", 0.35);
    inst->kit->symp = mix.nn("sympathy", 0.5);
    for (auto& kv : map) {
        std::string lbl = kv.second.p < (int) pcs.size() ? pcs.at(kv.second.p).str("name") : "?";
        const Slot& s = kv.second;
        if (!s.pedal.empty()) lbl += " (pedal " + s.pedal + ")";
        else if (s.open == s.open && s.open > 0.3) lbl += " (open)";
        else if (!s.mode.empty() && s.mode != "head") lbl += " (" + s.mode + ")";
        inst->pads.push_back({ kv.first, lbl });
    }
    std::sort(inst->pads.begin(), inst->pads.end(), [](const Pad& a, const Pad& b) { return a.note < b.note; });
    return inst;
}

void Instrument::noteOn(int note, double vel) { if (kit) kit->noteOn(note, vel); }
void Instrument::noteOff(int note) { if (kit) kit->noteOff(note); }
void Instrument::hatPedal(double down) { if (kit) kit->cc(4, down); }
void Instrument::process(float* L, float* R, int n)
{
    if (kit) kit->process(L, n, R);
    else if (player) player->process(L, n, R);
    else for (int i = 0; i < n; i++) L[i] = R[i] = 0;
}

} // namespace dh
