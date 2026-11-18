// Real-time metal core: port of engine.js MetalCore (cymbals, hi-hats, stacks, gongs, bells).
#include "dh_drum.h"
#include "dh_internal.h"
#include "dh_util.h"
#include <algorithm>
#include <map>

namespace dh {

double cymEq(double f, const std::string& piece)
{
    static const std::vector<std::pair<double, double>> ride = { { 120, -18 }, { 250, -13 }, { 400, -9 }, { 700, -5 }, { 1200, -2 }, { 2000, 0 }, { 3500, 3 }, { 6000, 6 }, { 10000, 4 } };
    static const std::vector<std::pair<double, double>> crash = { { 120, -20 }, { 250, -18 }, { 400, -14 }, { 700, -9 }, { 1200, -8 }, { 2000, -5 }, { 3500, 0 }, { 7000, 2 }, { 12000, 1 } };
    static const std::vector<std::pair<double, double>> china = { { 120, -18 }, { 250, -15 }, { 400, -11 }, { 700, -6 }, { 1200, -4 }, { 2000, -3 }, { 3500, 0 }, { 7000, 1 }, { 12000, 0 } };
    static const std::vector<std::pair<double, double>> hihat = { { 250, -2 }, { 500, 5 }, { 700, 3 }, { 1000, -5 }, { 1300, -8 }, { 1800, -5 }, { 2500, -4 }, { 4000, -2 }, { 8000, 2 }, { 12000, 4 } };
    const auto& T = piece == "hihat" ? hihat : piece == "ride" ? ride : (piece == "china" || piece == "trash") ? china : crash;
    if (f <= T[0].first) return std::pow(10.0, T[0].second / 20);
    for (size_t i = 1; i < T.size(); i++) if (f <= T[i].first) {
        double u = std::log(f / T[i - 1].first) / std::log(T[i].first / T[i - 1].first);
        return std::pow(10.0, (T[i - 1].second + u * (T[i].second - T[i - 1].second)) / 20);
    }
    return std::pow(10.0, T.back().second / 20);
}

namespace {

struct Group {
    std::vector<int> ids; double b0 = 0, a1 = 0, a2 = 0, norm = 0;
    double zL[2] = { 0, 0 }, zR[2] = { 0, 0 };
    double eC = 0, eL = 0, eR = 0, tC = 0, tL = 0, tR = 0;
    bool osc = false; int K = 0; std::vector<double> c, s, x, y, wA, wB, wo; double kc = 0, kn = 0;
};
struct HHPoint { std::vector<double> d, pt, pb; double Y = 0, tilt = 0, F = 0, s = 0, sv = 0, sp = 0; };
struct HH {
    std::vector<int> cIdx; double cd = 0; HHPoint pts[4]; double mt = 0, kp = 0, cz = 0, z = 0, vz = 0, gap = 0, pre = 0, open = 0, target = 0, kc = 0;
    bool stack = false; bool splash = false; double splashReopen = 0; int splashCd = -1;
};
struct RatW { double y = 0, v = 0, Fp = 0; };
struct Rat { std::vector<double> psi; double Y = 0, lvl = 0, m = 0, gap = 0, kc = 0; RatW w[3]; double env = 0, fc = 0, s1 = 0, s2 = 0; bool chain = false; };
struct Bow { bool on = false; std::vector<double> psi; double N = 0, vb = 0, hv = 0, F = 0, amp = 0; };

class MetalCore : public Core {
public:
    explicit MetalCore(double sr_) : sr(sr_) {}
    bool isMetal() const override { return true; }
    bool hasPedal() const override { return true; }

    void setModel(std::shared_ptr<Model> mdl) override
    {
        bool same = model && N == (int) mdl->modes.size();
        model = mdl; const Model& M = *mdl; const auto& modes = M.modes;
        N = (int) modes.size(); nB = M.nTop; dt = 1 / sr;
        auto A = [&](std::vector<double>& x) { x.assign(N, 0); };
        A(w2); A(a2); A(invM); A(chW); A(ck); A(sk); A(qs); A(oC); A(mmx); A(hhW);
        double g = M.gamma, bl = M.bloom, w0 = INFINITY, k0 = 1;
        for (auto& md : modes) if (md.ms == MS::Plate && md.w < w0) { w0 = md.w; k0 = md.k; }
        double glideC = M.glide * 3 * g * k0 * k0 / (w0 * w0);
        int nPlate = 0;
        for (int i = 0; i < N; i++) {
            const Mode& md = modes[i]; bool ok = md.w * dt < 1.9; double wd = ok ? 2 / dt * std::sin(md.w * dt / 2) : 0;
            w2[i] = wd * wd; a2[i] = ok ? 2 * md.alpha : 0; invM[i] = ok ? 1 / md.M : 0;
            chW[i] = 30 + 0.003 * md.w; hhW[i] = 115 + 420 * std::exp(-md.f / 900) + 260 * std::pow(md.f / 9000, 3);
            oC[i] = md.outW; mmx[i] = ok ? jmax(0, 3.3 / (w2[i] * dt * dt) - 1) : 0;
            bool plate = md.ms == MS::Plate && ok;
            if (plate) nPlate++;
            sk[i] = plate ? 0.25 * md.k * md.k : 0;
            ck[i] = (plate && md.w * dt < 1.2) ? (bl * g * md.k * md.k / (md.w * md.w) + glideC) : 0;
            qs[i] = plate ? (hashf(i, 31) < 0.5 ? -1 : 1) * md.k : 0;
        }
        const std::string& pc = M.piece;
        bool cymJ = pc == "crash" || pc == "ride" || pc == "splash" || pc == "china" || pc == "trash" || pc == "hihat" || pc == "stack";
        bool hats = pc == "hihat" || pc == "stack";
        A(jit); A(jS); A(jD); for (auto& c : jC) A(c); for (auto& l : jL) l = 0; jOn = cymJ;
        if (cymJ) for (int ij = 0; ij < N; ij++) {
            const Mode& mj = modes[ij];
            if (!(mj.ms == MS::Plate || mj.ms == MS::Proxy || (mj.cup && pc != "ride")) || !w2[ij]) continue;
            double fj = mj.f, dj = fj < 120 ? 0 : 0.0045 * jmin(1.6, std::sqrt(fj / 3000)) + 0.008 * std::exp(-fj / 1000) * (pc == "ride" ? 0.6 : (pc == "china" || pc == "trash" || pc == "splash") ? 1.4 : 1);
            if (mj.spread) dj = jmax(dj, (mj.ms == MS::Proxy ? 0.6 : 0.35) * mj.spread);
            jD[ij] = 2 * dj * (hats || !cymJ ? 1 : 0.35);
            double nn = 0; for (int kj = 0; kj < 4; kj++) { double c = hashf(ij, 40 + kj) * 2 - 1; jC[kj][ij] = c; nn += c * c; }
            nn = 1 / std::sqrt(nn + 1e-9); for (int kj = 0; kj < 4; kj++) jC[kj][ij] *= nn;
        }
        const double jf[4] = { 3, 5.5, 8, 12 }; for (int k = 0; k < 4; k++) jG[k] = 1 - std::exp(-TAU * jf[k] * 32 * dt);
        jSeed = 777; jAmp = 0;
        qB = 0;   // QB = 0 in engine.js: the quadratic curvature term is off
        std::vector<const Mode*> mlist; for (auto& md : modes) mlist.push_back(&md);
        MicW mw = micWeights(mlist, [](const Mode& md, double r, double th) { return metalShape(md, r, th); }, M.mics, nullptr);
        oHL = mw.L; oHR = mw.R; mcL = mw.cL; mcR = mw.cR; moh = mw.oh;
        bool washy = cymJ; const std::string& pcW = pc;
        double f50 = pcW == "ride" ? 600 : (pcW == "china" || pcW == "trash") ? 450 : pcW == "splash" ? 550 : pcW == "hihat" ? 250 : pcW == "stack" ? 450 : 600;
        wTone.assign(N, 0);
        std::vector<int> pidx;
        for (int ip = 0; ip < N; ip++) {
            const Mode& mp = modes[ip]; if (!w2[ip]) continue;
            if (mp.ms == MS::Proxy) pidx.push_back(ip);
            else if (washy && mp.ms == MS::Plate && mp.f > 100) { pidx.push_back(ip); wTone[ip] = 1 / (1 + std::pow(mp.f / f50, 2)); }
        }
        std::stable_sort(pidx.begin(), pidx.end(), [&](int x, int y) { return modes[x].f < modes[y].f; });
        std::map<int, std::vector<int>> bandOf;
        for (int ip : pidx) bandOf[(int) std::floor(2 * std::log2(modes[ip].f / 200))].push_back(ip);
        groups.clear();
        const Json& spc = M.cfg.get("special");
        bool lightQ = spc.str("quality") == "light" || M.cfg.truthy("lite");
        for (auto& kv : bandOf) {
            const auto& ids = kv.second; if (ids.empty()) continue;
            double flo = modes[ids.front()].f, fhi = modes[ids.back()].f, fc0 = std::sqrt(flo * fhi);
            double bw = washy && !hats ? jmax(fc0 * 0.12, 0.5 * (fhi - flo)) : jmax(fc0 * 0.25, fhi - flo);
            double wq = TAU * jmin(0.45 * sr, fc0) / sr, Q = jmax(0.6, fc0 / bw), al = std::sin(wq) / (2 * Q);
            Group G; G.ids = ids; G.b0 = al / (1 + al); G.a1 = -2 * std::cos(wq) / (1 + al); G.a2 = (1 - al) / (1 + al);
            double z1 = 0, z2 = 0, acc = 0; uint32_t seed = 99;
            for (int t = 0; t < 4096; t++) { seed = lcg(seed); double xn = seed / 2147483648.0 - 1, y = G.b0 * xn + z1; z1 = -G.a1 * y + z2; z2 = -G.b0 * xn - G.a2 * y; if (t > 512) acc += y * y; }
            G.norm = 1 / std::sqrt(acc / 3583 + 1e-12);
            if (washy) {
                int bk = kv.first; double eLo = 200 * std::pow(2.0, bk / 2.0), eHi = jmin(0.45 * sr, 200 * std::pow(2.0, (bk + 1) / 2.0));
                double dens = lightQ ? 8 : 20, Kmx = lightQ ? 14 : 40;
                int K = (int) jmax(lightQ ? 4 : 7, jmin(Kmx, jsround(dens * (eHi - eLo) / 1000)));
                double cSeed = jsround(std::fmod(M.top.a * 997 + M.top.heff * 7.3e4 + modes.size() * 13.0, 9973));
                if (eHi > eLo * 1.05) {
                    G.osc = true; G.K = K; G.c.assign(K, 0); G.s.assign(K, 0); G.x.assign(K, 0); G.y.assign(K, 0); G.wA.assign(K, 0); G.wB.assign(K, 0); G.wo.assign(K, 0);
                    double sA = 0, sB = 0;
                    for (int ko = 0; ko < K; ko++) {
                        double fo = eLo + (eHi - eLo) * (ko + 0.15 + 0.7 * hashf(bk * 131 + ko + cSeed, 91)) / K, wo = TAU * fo / sr, ph = TAU * hashf(bk * 131 + ko, 92);
                        G.wo[ko] = wo; G.c[ko] = std::cos(wo); G.s[ko] = std::sin(wo); G.x[ko] = std::cos(ph); G.y[ko] = std::sin(ph);
                        G.wA[ko] = 0.3 + 0.7 * hashf(bk * 131 + ko, 93); G.wB[ko] = 0.3 + 0.7 * hashf(bk * 131 + ko, 94); sA += G.wA[ko] * G.wA[ko]; sB += G.wB[ko] * G.wB[ko];
                    }
                    double nA = std::sqrt(2 / sA), nB2 = std::sqrt(2 / sB); for (int ko = 0; ko < K; ko++) { G.wA[ko] *= nA; G.wB[ko] *= nB2; }
                    double nSh = pcW == "ride" ? 0.5 : (pcW == "china" || pcW == "trash") ? 0.5 : pcW == "hihat" ? 0.85 : pcW == "stack" ? 0.5 : 0.45;
                    G.kc = std::sqrt(1 - nSh); G.kn = std::sqrt(nSh);
                }
            }
            groups.push_back(std::move(G));
        }
        pOC.assign(N, 0); pOL.assign(N, 0); pOR.assign(N, 0);
        double tone = hats ? 0.08 : (pc == "china" || pc == "trash") ? 0.3 : pc == "ride" ? 0.55 : (pc == "crash" || pc == "splash") ? 0.45 : (pc == "tamtam" || pc == "opera" || pc == "nipple") ? 0.85 : 0.8;
        if (spc.str("quality") == "light" && !hats) tone *= 0.8;
        oD.assign(N, 0); dingE = 0; dingK = std::exp(-1 / ((pc == "ride" ? 0.1 : 0.035) * sr));
        bool cymT = washy && !hats;
        for (auto& G : groups) for (int i8 : G.ids) {
            double kt, kn;
            if (modes[i8].ms != MS::Proxy) { kt = std::sqrt(wTone[i8]); kn = std::sqrt(1 - wTone[i8]); }
            else { double tP = cymT ? tone * 0.0 : tone; kt = std::sqrt(tP); kn = std::sqrt(1 - tP); }
            double fq = modes[i8].f;
            double hsT = cymT && fq > 2500 ? std::pow(fq / 2500, pcW == "ride" ? -0.7 : -0.35 - M.dark) : 1;
            double nsT = cymT && fq > 1000 ? std::pow(fq / 1000, pcW == "ride" ? -0.3 : -0.4 - M.dark) : 1;
            double eqW = cymT || pcW == "hihat" ? cymEq(fq, pcW) : 1; hsT *= eqW;
            kn *= hsT * nsT; kt *= hsT;
            if (cymT && modes[i8].ms != MS::Proxy) oD[i8] = oC[i8] * hsT * (1 - std::sqrt(wTone[i8]));
            else if (cymT && pcW == "ride") oD[i8] = 0;
            pOC[i8] = oC[i8] * kn; pOL[i8] = oHL[i8] * kn; pOR[i8] = oHR[i8] * kn; oC[i8] *= kt; oHL[i8] *= kt; oHR[i8] *= kt;
        }
        if (pcW == "ride") { double wg = 0.6; for (int iw = 0; iw < N; iw++) { if (modes[iw].f < 0) continue; pOC[iw] *= wg; pOL[iw] *= wg; pOR[iw] *= wg; } }
        if (cymT) for (int ic = 0; ic < N; ic++) if (modes[ic].cup) { double cuK = pcW == "ride" ? 0.55 : 0.2; oC[ic] *= cuK; oHL[ic] *= cuK; oHR[ic] *= cuK; }
        if (cymT) for (int iq = 0; iq < N; iq++) { const Mode& mq = modes[iq]; if (mq.ms == MS::Plate && mq.f <= 100 && w2[iq]) { double e = cymEq(mq.f, pcW); oC[iq] *= e; oHL[iq] *= e; oHR[iq] *= e; } }
        nseed = 4242; gHP = 1 - std::exp(-TAU * 1600 / sr); gLP = 1 - std::exp(-TAU * 6000 / sr); gSzH = 1 - std::exp(-TAU * 4000 / sr); gSzL = 1 - std::exp(-TAU * jmin(0.45 * sr, 14000) / sr);
        double fmin = INFINITY, fmx = 0;
        for (int i = 0; i < N; i++) if (modes[i].ms == MS::Plate && w2[i]) { fmin = jmin(fmin, modes[i].f); fmx = jmax(fmx, modes[i].f); }
        const int NBD = 10; std::vector<std::vector<int>> bnd(NBD);
        for (int i = 0; i < N; i++) {
            const Mode& mm = modes[i]; if (!((mm.ms == MS::Plate || mm.ms == MS::Proxy) && w2[i])) continue;
            double bi = std::floor(NBD * std::log(mm.f / fmin) / std::log(fmx / fmin * 1.0001));
            double cl = bi != bi ? NAN : std::max(0.0, std::min((double) NBD - 1, bi));   // (NaN -> index undefined in JS: push is skipped)
            if (cl == cl) bnd[(int) cl].push_back(i);
        }
        bands.clear(); for (auto& b : bnd) if (!b.empty()) bands.push_back(b);
        mcap = M.pair ? 1e9 : (pc == "tamtam" || pc == "opera" || pc == "nipple") ? 0.5 : 0.04;
        cascK = 3000 * M.bloom * (pc == "tamtam" ? 0.3 : pc == "china" ? 1.6 : pc == "ride" ? 0.5 : 1);
        h2inv = 1 / (M.top.heff * M.top.heff); cascN = 0;
        if (!same) { q.assign(N, 0); v.assign(N, 0); mallets.clear(); pulses.clear(); }
        bloomA = M.pair ? 0.03 : 0.0012;
        washRel = pc == "hihat" ? 0.0015 : 0.03;
        hasQ0 = false; narrow = hats ? 0.5 : 0;
        needSettle = !same && M.pair;
        // rattlers
        double nr = M.rivets + (M.chain ? 1 : 0);
        hasRat = false;
        if (nr > 0) {
            rat = Rat(); rat.psi.assign(N, 0); int K = (int) jmax(1, M.rivets ? M.rivets : 3);
            for (int j = 0; j < M.nTop; j++) { double s = 0; for (int kk = 0; kk < K; kk++) s += metalShape(modes[j], 0.88, TAU * kk / K + 0.2); rat.psi[j] = modes[j].w * dt > 0.8 ? 0 : s / std::sqrt((double) K); }
            double Yr = 0; for (int j = 0; j < N; j++) Yr += rat.psi[j] * rat.psi[j] * invM[j];
            bool chain = M.chain;
            rat.Y = Yr; rat.lvl = jmin(1.5, 0.35 + 0.1 * M.rivets) + (chain ? 0.6 : 0); rat.m = chain ? 0.004 : 0.0006; rat.gap = chain ? 0.0004 : 0.00008;
            rat.kc = 4e5; rat.fc = chain ? 2500 : 6500; rat.chain = chain; hasRat = true;
        }
        // hi-hat / stack contacts
        bool hadHH = hasHH0; hhOn = false;
        if (M.pair) {
            double prevZ = hh.z;
            HH H; const int KP = 4;
            for (int p = 0; p < KP; p++) {
                double th = TAU * p / KP + 0.4; HHPoint& P = H.pts[p]; P.pt.assign(N, 0); P.pb.assign(N, 0); P.d.assign(N, 0); double Y = 0;
                for (int i = 0; i < N; i++) {
                    const Mode& m = modes[i]; double val = metalShape(m, 0.97, th);
                    if (m.ms == MS::Proxy || m.w * dt > 0.8) val = 0;
                    if (m.which == 0) P.pt[i] = val; else P.pb[i] = val;
                    Y += val * val * invM[i];
                }
                for (int i = 0; i < N; i++) P.d[i] = P.pt[i] - P.pb[i];
                P.Y = Y; P.tilt = M.hhTilt * 1e-3 * std::cos(th);
            }
            clashPsi.assign(N, 0);
            for (int p2 = 0; p2 < 6; p2++) { double th2 = TAU * p2 / 6 + 0.2; for (int i = 0; i < N; i++) { double v9 = metalShape(modes[i], 0.97, th2); clashPsi[i] += modes[i].w * dt > 0.8 ? 0 : (modes[i].which == 0 ? v9 : -v9) / 6; } }
            for (int i = 0; i < N; i++) if (H.pts[0].d[i] || H.pts[1].d[i] || H.pts[2].d[i] || H.pts[3].d[i]) H.cIdx.push_back(i);
            double mt = M.top.mass, fp = 18 + 40 * M.hhClutch; bool stack = pc == "stack";
            H.cd = 2 * std::sqrt(2.5e6 * mt) * 0.25; H.mt = mt; H.kp = mt * std::pow(TAU * fp, 2); H.cz = 2 * mt * TAU * fp * (0.25 + 0.4 * M.hhClutch);
            H.z = hadHH ? prevZ : (stack ? -(0.4 + 1.2 * M.hhPress) * 1e-3 : std::pow(M.hhOpen, 3) * M.hhGap * 1e-3); H.vz = 0;
            H.gap = M.hhGap * 1e-3; H.pre = (stack ? 0.4 + 1.2 * M.hhPress : 0.15) * 1e-3; H.open = stack ? 0 : M.hhOpen; H.kc = 2.5e6; H.stack = stack;
            H.target = H.open;
            hh = std::move(H); hhOn = true; hasHH0 = true;
            if (hh.stack && FhPrev != FhPrev) FhPrev = 1;
        }
        if (!(hasBow && bow.on)) hasBow = false;
        w2b = w2; double p0 = pitch; pitch = 1; setPitch(p0);
    }

    void setPitch(double ratio) override
    {
        if (ratio == pitch) return;
        pitch = ratio; double r2 = ratio * ratio, lim = (1.95 / dt) * (1.95 / dt);
        for (int i = 0; i < N && i < (int) w2b.size(); i++) {
            if (!w2b[i]) continue;
            w2[i] = std::min(w2b[i] * r2, lim); mmx[i] = jmax(0, 3.3 / (w2[i] * dt * dt) - 1);
        }
        for (auto& G : groups) if (G.osc) for (int ko = 0; ko < G.K; ko++) { double w = G.wo[ko] * ratio; G.c[ko] = std::cos(w); G.s[ko] = std::sin(w); }
    }

    void settle() override
    {
        int n = (int) jsround(0.25 * sr); float tmp[256];
        q0.assign(q.size(), 0); hasQ0 = true;
        for (int o = 0; o < n; o += 32) { process(tmp, 32, nullptr); q0 = q; for (auto& x : v) x *= 0.4; hh.vz *= 0.4; hhEnv = 0; }
        std::fill(v.begin(), v.end(), 0.0); pulses.clear(); hhEnv = 0; hh.vz = 0; cascN = 0; q0 = q; if (!hh.stack) hasQ0 = false;
        int n2 = (int) jsround(0.6 * sr); for (int o2 = 0; o2 < n2; o2 += 256) process(tmp, 256, nullptr);
        pulses.clear(); hhEnv = 0;
        for (auto& G : groups) G.eC = G.eL = G.eR = G.tC = G.tL = G.tR = 0;
    }
    void pedalSplash(double reopen) override
    {
        if (!hhOn || hh.stack) return; hh.target = 0; hh.splash = true; hh.splashReopen = reopen; hh.splashCd = -1; sinceHit = 0; parked = false;
    }
    void setPedal(double open) override { if (hhOn && !hh.stack) { hh.target = jmax(0, jmin(1, open)); sinceHit = 0; parked = false; } }

    std::vector<double> makePsi(double r, double th, double rc, double edgeBoost) const
    {
        const auto& md = model->modes; std::vector<double> out(N, 0.0);
        for (int i = 0; i < N; i++) { if (md[i].which == 1) continue; out[i] = metalShape(md[i], r, th) * std::exp(-std::pow(md[i].k * rc, 2) / 8) * (edgeBoost ? 1 + edgeBoost * r : 1); }
        return out;
    }
    void strike(double r, double th, double vel, const std::string& mode, const Mallet* mlOverride) override
    {
        sinceHit = 0; parked = false; dingE = 1;
        if (!model) return;
        const Mallet& ml = mlOverride ? *mlOverride : *model->mallet; bool shoulder = mode == "shoulder";
        double mass = ml.mass * (shoulder ? 1.6 : 1), tau = ml.tau * TAUMET * (shoulder ? 1.5 : 1), rc = shoulder ? jmax(0.015, ml.rc) : ml.rc;
        double v0 = ml.vmax * std::pow(jmax(0.01, jmin(1, vel)), 1.3);
        auto psi = makePsi(jmin(0.995, r), th, rc, shoulder ? 0.6 : 0);
        double klin = mass * std::pow(PI / tau, 2), d0 = 3 * tau / PI, kc = klin * std::pow(d0, 1 - ml.alpha);
        double Y = 0, h = 0, hv = 0; for (int i = 0; i < N; i++) { Y += psi[i] * psi[i] * invM[i]; h += psi[i] * q[i]; hv += psi[i] * v[i]; }
        if (mallets.size() > 1) mallets.erase(mallets.begin());
        Contact c; c.psi = std::move(psi); c.Y = Y; c.y = h; c.v = v0; c.v0 = v0; c.m = mass; c.kc = kc; c.al = ml.alpha; c.loss = jmin(0.85, 2 * ml.lam); c.h = h; c.hv = hv;
        mallets.push_back(std::move(c));
    }
    void addPulse(double r, double th, double amp, double dur, double delay) override
    {
        if (!model) return; auto ps = std::make_shared<std::vector<double>>(makePsi(jmin(0.99, r), th, 0.006, 0));
        pulses.push_back(Pulse{ -delay, dur, amp, 0, 0, ps.get(), ps });
    }
    void bowStart(double, double th, double vel) override
    {
        bow = Bow(); bow.on = true; bow.psi = makePsi(0.995, th, 0.004, 0.3); bow.N = 0.6 + 3.2 * vel; bow.vb = 0.05 + 0.12 * vel; hasBow = true;
    }
    void bowPressure(double vel) override { if (hasBow) bow.N = 0.6 + 3.2 * vel; }
    void bowStop() override { if (hasBow) bow.on = false; }
    bool bowOn() const override { return hasBow && bow.on; }
    void reset() override
    {
        peEnv = 0;
        if (q.empty() && !model) return;
        std::fill(q.begin(), q.end(), 0.0); std::fill(v.begin(), v.end(), 0.0); mallets.clear(); pulses.clear(); S = 0; P = 0; hasBow = false;
        if (hasRat) for (auto& w : rat.w) { w.y = 0; w.v = 0; w.Fp = 0; }
    }

    void process(float* out, int n, float* outR) override
    {
        if (!model) { for (int z = 0; z < n; z++) { out[z] = 0; if (outR) outR[z] = 0; } return; }
        const Model& md = *model;
        if (md.pair && hhOn) {
            sinceHit += n;
            double lim = (hh.stack ? 1.2 : 4) * sr;
            if (parked) { for (int z = 0; z < n; z++) { out[z] = 0; if (outR) outR[z] = 0; } return; }
            if (sinceHit > lim + 0.6 * sr && mallets.empty() && pulses.empty()) {
                std::fill(v.begin(), v.end(), 0.0); if (hasQ0) q = q0; parked = true; hhEnv = 0;
                for (auto& G : groups) G.eC = G.eL = G.eR = G.tC = G.tL = G.tR = 0;
                for (int z = 0; z < n; z++) { out[z] = 0; if (outR) outR[z] = 0; }
                return;
            }
            if (sinceHit > lim && mallets.empty() && pulses.empty()) {
                double fd = std::exp(-n / ((hh.stack ? 0.2 : 0.5) * sr));
                for (int zi = 0; zi < N; zi++) { v[zi] *= fd; if (hasQ0) q[zi] = q0[zi] + (q[zi] - q0[zi]) * fd; }
                hhEnv = hhEnv * fd;
            }
        }
        HH* H = hhOn ? &hh : nullptr; Rat* rt = hasRat ? &rat : nullptr;
        double fsv = rt ? 2 * std::sin(PI * jmin(0.24, rt->fc / sr)) : 0;
        if (plF.size() < 8) { plF.resize(8); plP.resize(8); }
        for (int s = 0; s < n; s++) {
            if ((++cascN & 31) == 0) { cascade(32 * dt); bedEnv(); if (jOn) diffuse(); }
            int jp = cascN & 31;
            int npl = 0;
            if (plF.size() < pulses.size()) { plF.resize(pulses.size()); plP.resize(pulses.size()); }
            for (int pi = (int) pulses.size() - 1; pi >= 0; pi--) {
                Pulse& P_ = pulses[pi]; P_.t += dt; if (P_.t < 0) continue;
                if (P_.t >= P_.dur) { pulses.erase(pulses.begin() + pi); continue; }
                plF[npl] = P_.amp * std::sin(PI * P_.t / P_.dur); plP[npl] = P_.psi->data(); npl++;
            }
            chk = chk + (chkT - chk) * 0.002; double ch = chk;
            double clamp = 0;
            if (H) {
                clamp = H->z <= 0 ? 0.6 + 0.4 * jmin(1, -H->z / jmax(1e-5, H->pre)) : 0.5 * std::exp(-jmin(H->z, 0.0003) / 0.0006) * std::exp(-jmax(0, H->z - 0.0003) / 0.00025);
                if (H->stack) clamp *= 0.17;
                if (H->splash) clamp *= 0.15;
            }
            double Sg = S;
            double Frat = 0;
            if (rt) {
                double u = ru + ruv * dt;
                for (int wi = 0; wi < 3; wi++) {
                    RatW& Wr = rt->w[wi]; double dl = u - (Wr.y + Wr.v * dt), Fc = 0;
                    if (dl > 0) Fc = rt->kc * dl / (1 + rt->kc * dt * dt * (rt->Y * 3 + 1 / rt->m));
                    double acc0 = (Fc - rt->m * 9.8) / rt->m - 4 * Wr.v;
                    if (Wr.y < -rt->gap && Wr.v < 0) { Wr.v = -Wr.v * 0.3; Wr.y = -rt->gap; }
                    Wr.v += acc0 * dt; Wr.y += Wr.v * dt;
                    double dF = Fc - Wr.Fp; Wr.Fp = Fc; rt->env += (dF < 0 ? -dF : dF) * 0.4;
                    Frat += Fc;
                }
                Frat = -Frat;
            }
            double Fb = 0;
            if (hasBow) {
                if (bow.on) { double vr = bow.vb - bow.hv, mu = 0.35 + 0.55 / (1 + std::fabs(vr) / 0.006); Fb = bow.N * mu * std::tanh(vr / 0.002); bow.amp = jmin(1, bow.amp + 0.0004); }
                else { bow.amp *= 0.995; Fb = 0; if (bow.amp < 1e-3) hasBow = false; }
                if (hasBow) Fb *= bow.amp;
            }
            int nm = (int) mallets.size(); Contact* m0 = nm > 0 ? &mallets[0] : nullptr; Contact* m1 = nm > 1 ? &mallets[1] : nullptr;
            const double* ps0 = m0 ? m0->psi.data() : nullptr; const double* ps1 = m1 ? m1->psi.data() : nullptr;
            double h0 = 0, h1 = 0; bool hhC = H && H->z < 0.006;
            double s0 = 0, s1 = 0, s2 = 0, s3 = 0;
            const double* d0 = hhC ? H->pts[0].d.data() : nullptr; const double* d1 = hhC ? H->pts[1].d.data() : nullptr;
            const double* d2 = hhC ? H->pts[2].d.data() : nullptr; const double* d3 = hhC ? H->pts[3].d.data() : nullptr;
            const double* rpsi = rt ? rt->psi.data() : nullptr; const double* bpsi = hasBow ? bow.psi.data() : nullptr;
            const double* Q0 = hasQ0 ? q0.data() : nullptr; double DMX = 0.5 / dt, MCAP = mcap;
            for (int i = 0; i < N; i++) {
                double f = 0;
                for (int pk = 0; pk < npl; pk++) f += plF[pk] * plP[pk][i];
                if (rpsi) f += Frat * rpsi[i];
                if (bpsi) f += Fb * bpsi[i];
                double qi = q[i], mod = ck[i] * Sg + jit[i] + jS[i] * jp;
                if (mod > 0) { mod = mod * MCAP / (MCAP + mod); if (mod > mmx[i]) mod = mmx[i]; }
                double Dm = a2[i] + ch * chW[i] + clamp * hhW[i]; if (Dm > DMX) Dm = DMX;
                double ac = f * invM[i] - w2[i] * (qi + mod * (Q0 ? qi - Q0[i] : qi)) - Dm * v[i];
                double vi = v[i] + ac * dt; qi += vi * dt; v[i] = vi; q[i] = qi;
                if (ps0) h0 += ps0[i] * qi;
                if (ps1) h1 += ps1[i] * qi;
            }
            if (hhC) for (int jq : H->cIdx) { double qq = q[jq]; s0 += d0[jq] * qq; s1 += d1[jq] * qq; s2 += d2[jq] * qq; s3 += d3[jq] * qq; }
            double F0 = 0, F1 = 0;
            for (int k = 0; k < nm; k++) {
                Contact& M_ = mallets[k]; double hp = k == 0 ? h0 : h1, F = 0;
                double del = M_.gone ? -1 : (M_.y + M_.v * dt) - hp;
                if (del > 0) {
                    double ks = M_.kc * std::pow(del, M_.al - 1);
                    F = ks * del / (1 + ks * dt * dt * (M_.Y + 1 / M_.m));
                    if (M_.v < 0) { double uu = jmin(1, -M_.v / (0.2 * M_.v0)); F *= 1 - M_.loss * uu * uu * (3 - 2 * uu); }
                }
                if (F > 0) M_.hit = true; else if (M_.hit && M_.v <= 0) M_.gone = true;
                M_.F = F; M_.v -= F / M_.m * dt; M_.y += M_.v * dt; M_.life += dt;
                if (k == 0) F0 = F * dt; else F1 = F * dt;
            }
            bool anyFh = false; double Fsum = 0;
            if (H) {
                double tgtZ = H->stack ? -H->pre : (H->target * H->target * H->target * H->gap - H->pre * (1 - jmin(1, H->target * 6)));
                double Fz = 0;
                if (hhC) {
                    H->pts[0].s = s0; H->pts[1].s = s1; H->pts[2].s = s2; H->pts[3].s = s3;
                    anyFh = true;
                    for (int c2 = 0; c2 < 4; c2++) {
                        HHPoint& pt2 = H->pts[c2]; double sep = (H->z + H->vz * dt) + pt2.tilt + pt2.s, Fc2 = 0;
                        if (sep < 0) {
                            double Yt = 4 * (pt2.Y + 1 / H->mt), sv = (sep - pt2.sp) / dt;
                            Fc2 = (H->kc * (-sep) - H->cd * sv) / (1 + (H->kc * dt * dt + H->cd * dt) * Yt);
                            if (Fc2 < 0) Fc2 = 0;
                        }
                        pt2.sp = sep;
                        Fh[c2] = Fc2 * dt; Fz += Fc2; Fsum += Fc2;
                    }
                }
                double az = (-H->kp * (H->z - tgtZ) - H->cz * H->vz + Fz) / H->mt;
                H->vz += az * dt; H->z += H->vz * dt;
            }
            double S2 = 0, P2 = 0, oc = 0, ol = 0, orr = 0, hv0 = 0, hv1 = 0, ru_ = 0, ruv_ = 0, bhv = 0, od = 0;
            if (anyFh && (Fh[0] || Fh[1] || Fh[2] || Fh[3])) {
                double f0 = Fh[0], f1 = Fh[1], f2 = Fh[2], f3 = Fh[3];
                for (int jj : H->cIdx) { double dvh = (f0 * d0[jj] + f1 * d1[jj] + f2 * d2[jj] + f3 * d3[jj]) * invM[jj]; v[jj] += dvh; q[jj] += dvh * dt; }
            }
            bool anyF = F0 || F1;
            for (int i2 = 0; i2 < N; i2++) {
                double vi2 = v[i2], qi2 = q[i2];
                if (anyF) {
                    double imp = F0 * (ps0 ? ps0[i2] : 0) + F1 * (ps1 ? ps1[i2] : 0);
                    if (imp) { double dv = imp * invM[i2]; vi2 += dv; qi2 += dv * dt; v[i2] = vi2; q[i2] = qi2; }
                }
                S2 += sk[i2] * qi2 * qi2;
                oc += oC[i2] * vi2; ol += oHL[i2] * vi2; orr += oHR[i2] * vi2; od += oD[i2] * vi2;
                if (ps0) hv0 += ps0[i2] * vi2;
                if (ps1) hv1 += ps1[i2] * vi2;
                if (rpsi) { ru_ += rpsi[i2] * qi2; ruv_ += rpsi[i2] * vi2; }
                if (bpsi) bhv += bpsi[i2] * vi2;
            }
            if (m0) m0->hv = hv0; if (m1) m1->hv = hv1;
            if (hasBow) bow.hv = bhv;
            S = S2; P = P2; ru = ru_; ruv = ruv_;
            for (int k3 = (int) mallets.size() - 1; k3 >= 0; k3--) { Contact& Mr = mallets[k3]; if (Mr.gone || Mr.life > 0.05) mallets.erase(mallets.begin() + k3); }
            double buzz = 0;
            if (rt) {
                noise = xorshift(noise);
                double wn = (double) noise / 2147483648.0, lp = rt->s2 + fsv * rt->s1, hpn = wn - lp - 1.1 * rt->s1, bp = fsv * hpn + rt->s1; rt->s1 = bp; rt->s2 = lp;
                rt->env *= rt->chain ? 0.996 : 0.993; if (rt->env > 80) rt->env = 80;
                double rz = rt->env * rt->lvl * 0.02, cap = 0.8 * peEnv;
                buzz = (rz > cap ? cap : rz) * bp;
            }
            if (H) {
                if (Fsum > 0 && !(FhPrev > 0) && H->vz < 0) {
                    hhEnv = hhEnv + jmin(8, -H->vz * CHICK);
                    double vimp = jmin(1.5, -H->vz), dur0 = 0.00035;
                    pulses.push_back(Pulse{ 0, dur0, -jmin(H->mt, 0.9) * vimp * 1.2 * PI / (2 * dur0) * 0.16, 0, 0, &clashPsi, nullptr });
                    if (H->splash && H->splashCd < 0) H->splashCd = (int) jsround(0.01 * sr);
                }
                if (H->splash && H->splashCd >= 0 && --H->splashCd < 0) { H->target = H->splashReopen; H->splash = false; }
                double fp0 = FhPrev == FhPrev ? FhPrev : 0;
                double dFh = Fsum - fp0; FhPrev = Fsum;
                Fav = Fav + 0.002 * (Fsum - Fav);
                double imp = dFh - 0.35 * Fav - 6; if (imp < 0) imp = 0;
                hhEnv = hhEnv * 0.9975 + imp * 2.5e-3;
                noise = xorshift(noise);
                double wn2 = (double) noise / 2147483648.0; hhHP = hhHP + gHP * (wn2 - hhHP);
                double hpn2 = wn2 - hhHP; hhHP2 = hhHP2 + gLP * (hpn2 - hhHP2);
                hhHP3 = hhHP3 + gLP * (hhHP2 - hhHP3);
                buzz += hhEnv * hhHP3 * 0.5;
                if (!H->stack && H->z > 0.0003) {
                    double hz = H->z / 0.003;
                    if (hz < 1) {
                        double prx = (1 - hz) * (1 - hz) * jmin(1, (H->z - 0.0003) / 0.0004);
                        double szx = wn2; szA = szA + gSzH * (szx - szA); double szh = szx - szA; szB = szB + gSzL * (szh - szB);
                        buzz += prx * 0.45 * peEnv * szB * 4;
                    }
                }
            }
            double bC = 0, bL = 0, bR = 0;
            for (auto& gr : groups) {
                double kA = gr.tC > gr.eC ? bloomA : washRel;
                gr.eC += (gr.tC - gr.eC) * kA; gr.eL += (gr.tL - gr.eL) * kA; gr.eR += (gr.tR - gr.eR) * kA;
                if (gr.eC + gr.eL + gr.eR < 1e-9) continue;
                double yA, yB;
                if (gr.osc) {
                    yA = 0; yB = 0;
                    for (int ko = 0; ko < gr.K; ko++) { double xo = gr.x[ko], yo = gr.y[ko], cc = gr.c[ko], ss = gr.s[ko], xn = xo * cc - yo * ss; gr.y[ko] = xo * ss + yo * cc; gr.x[ko] = xn; yA += gr.wA[ko] * xn; yB += gr.wB[ko] * xn; }
                    nseed = lcg(nseed); double m1n = nseed / 2147483648.0 - 1;
                    nseed = lcg(nseed); double m2n = nseed / 2147483648.0 - 1;
                    double zA = gr.b0 * m1n + gr.zL[0]; gr.zL[0] = -gr.a1 * zA + gr.zL[1]; gr.zL[1] = -gr.b0 * m1n - gr.a2 * zA;
                    double zB = gr.b0 * m2n + gr.zR[0]; gr.zR[0] = -gr.a1 * zB + gr.zR[1]; gr.zR[1] = -gr.b0 * m2n - gr.a2 * zB;
                    yA = gr.kc * yA + gr.kn * gr.norm * zA; yB = gr.kc * yB + gr.kn * gr.norm * zB;
                } else {
                    nseed = lcg(nseed); double n1 = nseed / 2147483648.0 - 1;
                    nseed = lcg(nseed); double n2 = nseed / 2147483648.0 - 1;
                    yA = gr.b0 * n1 + gr.zL[0]; gr.zL[0] = -gr.a1 * yA + gr.zL[1]; gr.zL[1] = -gr.b0 * n1 - gr.a2 * yA;
                    yB = gr.b0 * n2 + gr.zR[0]; gr.zR[0] = -gr.a1 * yB + gr.zR[1]; gr.zR[1] = -gr.b0 * n2 - gr.a2 * yB;
                    yA *= gr.norm; yB *= gr.norm;
                }
                bC += 0.5 * (yA + yB) * gr.eC * 1.41; bL += yA * gr.eL; bR += yB * gr.eR;
            }
            double aoc = std::fabs(oc) + std::fabs(bC) + 0.5 * (std::fabs(ol) + std::fabs(orr) + std::fabs(bL) + std::fabs(bR));
            peEnv = peEnv + (aoc > peEnv ? 0.05 : 0.00012) * (aoc - peEnv);
            double dgo = od * dingE; dingE *= dingK;
            double yC = oc + buzz + bC + dgo, yl = mcL * yC + moh * (ol + bL + buzz * 0.8 + 0.7 * dgo), yr = mcR * yC + moh * (orr + bR + buzz * 0.8 + 0.7 * dgo);
            if (narrow) { double yM = 0.5 * (yl + yr), yS = 0.5 * (yl - yr) * narrow; yl = yM + yS; yr = yM - yS; }
            if (yl != yl || yr != yr || yl > 1e6 || yl < -1e6) { reset(); yl = yr = 0; }
            out[s] = (float) yl; if (outR) outR[s] = (float) yr;
        }
    }

private:
    void cascade(double dtb)
    {
        int nb = (int) bands.size(); if (nb < 2 || !cascK) return;
        double sq = 0; int cnt = 0; if ((int) bE.size() < nb) bE.assign(nb, 0);
        for (int b = 0; b < nb; b++) { double e = 0; for (int i : bands[b]) { double vv0 = v[i] * v[i]; e += 2 * vv0; sq += vv0 / w2[i]; } bE[b] = e; cnt += (int) bands[b].size(); }
        double eps = sq / cnt * h2inv * (model->piece == "hihat" ? 40 : 15); lastEps = eps; if (eps < 1e-7) return;
        double rate = cascK * eps / (1 + eps) * dtb; if (rate > 0.4) rate = 0.4;
        for (int b2 = nb - 2; b2 >= 0; b2--) {
            double Eb = bE[b2]; if (Eb <= 1e-30) continue;
            double dE = Eb * rate * 0.5, keep = std::sqrt(jmax(0, 1 - 2 * dE / Eb));
            for (int i2 : bands[b2]) v[i2] *= keep;
            const auto& hi = bands[b2 + 1]; double per = dE / hi.size();
            for (int i3 : hi) { double vv = v[i3], sgn = vv != 0 ? (vv > 0 ? 1 : -1) : ((i3 & 1) ? 1 : -1); v[i3] = sgn * std::sqrt(vv * vv + per * 0.5); }
            bE[b2 + 1] += dE;
        }
    }
    void diffuse()
    {
        for (int k = 0; k < 4; k++) { jSeed = lcg(jSeed); double wn = jSeed / 2147483648.0 - 1; jL[k] += jG[k] * (wn * 1.73 * std::sqrt((2 - jG[k]) / jG[k]) - jL[k]); }
        double e = lastEps, amp = 0.35 + 1.6 * e / (e + 0.02);
        jAmp += 0.05 * (amp - jAmp);
        double a = jAmp, l0 = jL[0] * a, l1 = jL[1] * a, l2 = jL[2] * a, l3 = jL[3] * a;
        for (int i = 0; i < N; i++) { double d = jD[i]; if (!d) continue; jit[i] += 32 * jS[i]; jS[i] = (d * (jC[0][i] * l0 + jC[1][i] * l1 + jC[2][i] * l2 + jC[3][i] * l3) - jit[i]) / 32; }
    }
    void bedEnv()
    {
        bool pairB = model->pair;
        for (auto& gr : groups) {
            double c = 0, l = 0, r = 0;
            for (int i : gr.ids) { double e = pairB ? v[i] * v[i] : 0.5 * (v[i] * v[i] + w2[i] * q[i] * q[i]); c += pOC[i] * pOC[i] * e; l += pOL[i] * pOL[i] * e; r += pOR[i] * pOR[i] * e; }
            gr.tC = std::sqrt(c); gr.tL = std::sqrt(l); gr.tR = std::sqrt(r);
        }
    }

    double sr; int N = 0, nB = 0; double dt = 0;
    std::vector<double> w2b;
    std::vector<double> q, v, w2, a2, invM, chW, ck, sk, qs, oC, mmx, hhW, oHL, oHR, wTone, pOC, pOL, pOR, oD;
    std::vector<double> jit, jS, jD, jC[4]; double jL[4] = {}, jG[4] = {}; bool jOn = false; uint32_t jSeed = 777; double jAmp = 0;
    double qB = 0, mcL = 0, mcR = 0, moh = 0, dingE = 0, dingK = 0;
    std::vector<Group> groups; uint32_t nseed = 4242; double gHP = 0, gLP = 0, gSzH = 0, gSzL = 0;
    std::vector<std::vector<int>> bands; std::vector<double> bE; double mcap = 0.04, cascK = 0, h2inv = 0, lastEps = 0; int cascN = 0;
    double bloomA = 0, washRel = 0, narrow = 0; std::vector<double> q0; bool hasQ0 = false;
    double S = 0, P = 0, ru = 0, ruv = 0;
    Rat rat; bool hasRat = false;
    HH hh; bool hhOn = false, hasHH0 = false;
    std::vector<double> clashPsi; double Fh[4] = {}, FhPrev = NAN, Fav = 0, hhEnv = 0, hhHP = 0, hhHP2 = 0, hhHP3 = 0, szA = 0, szB = 0, peEnv = 0;
    int32_t noise = 777; bool parked = false;
    Bow bow; bool hasBow = false;
    std::vector<double> plF; std::vector<const double*> plP;
};

} // namespace

std::unique_ptr<Core> makeMetal(double sr) { return std::make_unique<MetalCore>(sr); }

} // namespace dh
