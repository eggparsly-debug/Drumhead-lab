// Headless renderer / checker for the C++ engine. Mirrors tools/jsrender.js so outputs can be compared.
//   dhrender hit <cfg.json> <out.f32> [seconds]          calibrated default stroke, mono float32
//   dhrender groove <kits.json> <kit name> <out.f32>     Studio-kit groove, L/R interleaved float32
//   dhrender --selftest [reference dir]                  builds every preset and kit, checks output is sane
#include "dh_drum.h"
#include "dh_util.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

using namespace dh;

static std::string readFile(const std::string& p)
{
    std::ifstream f(p, std::ios::binary); std::stringstream ss; ss << f.rdbuf(); return ss.str();
}
static void writeF32(const std::string& p, const std::vector<float>& x)
{
    std::ofstream f(p, std::ios::binary); f.write((const char*) x.data(), (std::streamsize) (x.size() * sizeof(float)));
}

static const double SR = 48000;

static std::vector<float> renderDefault(const Json& cfg, double sec, double* gainOut)
{
    auto m = buildModel(cfg, SR); calibrate(*m, SR); if (gainOut) *gainOut = m->gain;
    Player p(SR); p.setModel(m); p.gain = m->gain;
    if (m->tongue) {
        std::vector<const Tongue*> ts; for (auto& t : m->tongues) ts.push_back(&t);
        std::stable_sort(ts.begin(), ts.end(), [](const Tongue* a, const Tongue* b) { return a->f < b->f; });
        p.strikeTongue(ts[ts.size() / 2]->idx, 0.85);
    } else {
        const Json& st = cfg.get("strike");
        double r = st.get("r").isNullish() ? (m->metal ? 0.6 : 0.3) : st.num("r");
        double th = st.get("theta").isNullish() ? 0.4 : st.num("theta");
        std::string mode = st.truthy("mode") ? st.str("mode") : "head";
        p.strike(r, th, 0.85, mode);
    }
    int n = (int) jsround(sec * SR); std::vector<float> out(n);
    for (int o = 0; o < n; o += 512) p.process(out.data() + o, std::min(512, n - o), nullptr);
    return out;
}

struct Ev { long at; int note; double vel; };
static std::vector<Ev> grooveEvents(double sr)
{
    const double s16 = 60.0 / 96 / 4; std::vector<Ev> ev; double seed = 7;
    auto rnd = [&]() { seed = std::fmod(seed * 16807, 2147483647.0); return seed / 2147483647; };
    auto add = [&](double step, int n, double v) { double r1 = rnd(); long at = (long) jsround((step * s16 + (r1 - .5) * .006) * sr); double r2 = rnd(); ev.push_back({ at, n, std::min(1.0, v * (0.93 + r2 * .1)) }); };
    for (int bar = 0; bar < 8; bar++) {
        int o = bar * 16;
        if (bar == 0) add(o, 49, .9);
        for (int s = 0; s < 16; s += 2) { if (bar < 4) add(o + s, 42, s % 4 ? .5 : .72); else add(o + s, 51, s % 4 ? .55 : .75); }
        if (bar == 3) add(o + 14, 46, .7);
        for (int s : { 0, 7, 10 }) add(o + s, 36, s ? .75 : .9);
        if (bar % 2) add(o + 13, 36, .6);
        add(o + 4, 38, .9); add(o + 12, 38, .92); if (bar % 2 == 0) add(o + 15, 38, .25);
        if (bar == 7) { for (int s : { 8, 9, 10, 11 }) add(o + s, 48, .8); for (int s : { 12, 13 }) add(o + s, 45, .85); for (int s : { 14, 15 }) add(o + s, 41, .9); }
    }
    add(128, 49, .95); add(128, 36, .95); add(132, 55, .8);
    std::stable_sort(ev.begin(), ev.end(), [](const Ev& a, const Ev& b) { return a.at < b.at; });
    return ev;
}

static std::unique_ptr<Kit> loadKit(const Json& K, double sr)
{
    auto kit = std::make_unique<Kit>(sr);
    const Json& pcs = K.get("pieces");
    for (size_t i = 0; i < pcs.size(); i++) {
        Json c = pcs.at(i).get("cfg"); c.set("lite", Json::boolean(true));
        auto m = buildModel(c, sr); calibrate(*m, sr);
        double lv = pcs.at(i).num("level"), pn = pcs.at(i).num("pan");
        kit->setPiece((int) i, m, pcs.at(i).get("level").isNullish() ? nullptr : &lv, pcs.at(i).get("pan").isNullish() ? nullptr : &pn);
    }
    kit->setMap(parseKitMap(K.get("map")));
    kit->punch = K.get("mix").num("punch"); kit->symp = K.get("mix").num("sympathy");
    return kit;
}

static std::vector<float> renderGroove(const Json& K, double sr)
{
    auto kit = loadKit(K, sr); auto ev = grooveEvents(sr);
    auto mp = parseKitMap(K.get("map"));
    auto mapped = [&](int note) { for (auto& kv : mp) if (kv.first == note) return true; return false; };
    long N = (long) jsround((128 * 60.0 / 96 / 4 + 4) * sr);
    std::vector<float> L(N), R(N); size_t ei = 0;
    for (long b = 0; b < N; b += 64) {
        while (ei < ev.size() && ev[ei].at < b + 64) { if (mapped(ev[ei].note)) kit->noteOn(ev[ei].note, ev[ei].vel); ei++; }
        int n = (int) std::min<long>(64, N - b); kit->process(L.data() + b, n, R.data() + b);
    }
    std::vector<float> o(2 * N); for (long i = 0; i < N; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i]; }
    return o;
}

static int selftest(const std::string& dir)
{
    std::string err; Json P = Json::parse(readFile(dir + "/presets.json"), &err);
    if (!P.isObj()) { std::printf("FAIL: cannot read %s/presets.json (%s)\n", dir.c_str(), err.c_str()); return 1; }
    int bad = 0, n = 0;
    for (auto& kv : P.o) {
        auto t0 = std::chrono::steady_clock::now(); double g = 0;
        auto x = renderDefault(kv.second, 0.6, &g);
        double pk = 0; bool fin = true; for (float v : x) { if (!std::isfinite(v)) fin = false; pk = std::max(pk, (double) std::fabs(v)); }
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        bool ok = fin && pk > 1e-3 && pk < 1.0 && g > 0;
        if (!ok) bad++;
        n++;
        std::printf("%-34s %s peak %.3f  (%.0f ms)\n", kv.first.c_str(), ok ? "ok  " : "FAIL", pk, ms);
    }
    Json K = Json::parse(readFile(dir + "/kits.json"));
    if (K.isObj() && !K.o.empty()) {
        auto g = renderGroove(K.o.front().second, SR);
        double pk = 0; bool fin = true; for (float v : g) { if (!std::isfinite(v)) fin = false; pk = std::max(pk, (double) std::fabs(v)); }
        bool ok = fin && pk > 0.05 && pk <= 1.0; if (!ok) bad++;
        std::printf("%-34s %s peak %.3f\n", ("groove: " + K.o.front().first).c_str(), ok ? "ok  " : "FAIL", pk);
    }
    std::printf("%d presets, %d failures\n", n, bad);
    return bad ? 1 : 0;
}

int main(int argc, char** argv)
{
    if (argc < 2) { std::printf("usage: dhrender hit|groove|--selftest ...\n"); return 2; }
    std::string cmd = argv[1];
    if (cmd == "--selftest") return selftest(argc > 2 ? argv[2] : "reference");
    if (cmd == "hit" && argc >= 4) {
        Json cfg = Json::parse(readFile(argv[2])); double g = 0;
        auto x = renderDefault(cfg, argc > 4 ? std::atof(argv[4]) : 2, &g); writeF32(argv[3], x);
        std::printf("gain %.17g\n", g); return 0;
    }
    if (cmd == "groove" && argc >= 5) {
        Json KK = Json::parse(readFile(argv[2])); auto x = renderGroove(KK.get(argv[3]), SR); writeF32(argv[4], x); return 0;
    }
    std::printf("bad arguments\n"); return 2;
}
