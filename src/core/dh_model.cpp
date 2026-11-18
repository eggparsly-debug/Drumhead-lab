// Model building: port of engine.js lines 1-492 and 830-1029 (heads, shells, bars, tongues, bodies, metal plates).
#include "dh_drum.h"
#include "dh_util.h"
#include <algorithm>
#include <map>

namespace dh {

// ---------- Bessel tables ----------
static double besselJ(int m, double x)
{
    const int N = 112; double s = 0;
    for (int k = 0; k < N; k++) { double t = TAU * k / N; s += std::cos(m * t - x * std::sin(t)); }
    return s / N;
}
struct BesselTables {
    double ZEROS[MMAX + 1][NMAX]; double JNEXT[MMAX + 1][NMAX]; float RAD[MMAX + 1][NMAX][RTAB + 2];
    BesselTables() {
        for (int m = 0; m <= MMAX; m++) {
            int cnt = 0; double x = m == 0 ? 0.5 : m + 0.5, step = 0.1, prev = besselJ(m, x);
            while (cnt < NMAX) {
                double x2 = x + step, cur = besselJ(m, x2);
                if (prev * cur < 0) {
                    double lo = x, hi = x2, flo = prev;
                    for (int it = 0; it < 48; it++) { double mid = 0.5 * (lo + hi), fm = besselJ(m, mid); if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; } }
                    ZEROS[m][cnt++] = 0.5 * (lo + hi);
                }
                x = x2; prev = cur;
            }
            for (int n = 0; n < NMAX; n++) {
                double j = ZEROS[m][n]; JNEXT[m][n] = besselJ(m + 1, j);
                for (int i = 0; i <= RTAB + 1; i++) RAD[m][n][i] = (float) besselJ(m, j * std::min(1.0, (double) i / RTAB));
            }
        }
    }
};
static const BesselTables& BT() { static BesselTables t; return t; }
static double radial(int m, int n, double r)
{
    const float* tab = BT().RAD[m][n];
    if (r <= 0) return tab[0];
    double t = std::min(1.0, r) * RTAB; int i = (int) t; double f = t - i;
    return tab[i] + ((double) tab[i + 1] - tab[i]) * f;
}

// ---------- material tables ----------
static const std::map<std::string, HeadMat>& HEAD_MATS()
{
    static const std::map<std::string, HeadMat> m = {
        { "mylar_clear",  { "Mylar (clear)", 1390, 4.5e9, 0.006, 0.3, 0, 0.254, false, 1.2e8 } },
        { "mylar_coated", { "Mylar (coated)", 1390, 4.5e9, 0.016, 1.2, 0.025, 0.254, false, 1.2e8 } },
        { "mylar_2ply",   { "Mylar 2-ply (oil/film)", 1390, 4.5e9, 0.04, 1.6, 0.01, 0.356, false, 1.2e8 } },
        { "synth_skin",   { "Synthetic skin (fiber)", 1300, 3.5e9, 0.022, 1.2, 0.06, 0.254, false, 1e8 } },
        { "kevlar",       { "Aramid / Kevlar weave", 1440, 2.0e10, 0.012, 0.6, 0.02, 0.40, false, 4e8 } },
        { "calfskin",     { "Calfskin", 1100, 0.9e9, 0.015, 1.3, 0, 0.30, false, 6e7 } },
        { "goatskin",     { "Goatskin", 1080, 1.2e9, 0.012, 1.1, 0, 0.35, false, 6e7 } },
        { "cowhide",      { "Cowhide (thick rawhide)", 1150, 0.9e9, 0.008, 1.0, 0, 1.5, false, 6e7 } },
        { "deerskin",     { "Deerskin / elk", 1000, 0.5e9, 0.025, 1.7, 0, 0.6, false, 5e7 } },
        { "steel_sheet",  { "Steel sheet (pan / keg)", 7850, 200e9, 0.0006, 0.05, 0, 0.9, true, 0 } },
        { "brass_sheet",  { "Brass sheet", 8500, 100e9, 0.0009, 0.06, 0, 0.8, true, 0 } },
        { "alu_sheet",    { "Aluminum sheet", 2700, 69e9, 0.0012, 0.08, 0, 1.0, true, 0 } },
        { "fishskin",     { "Fish skin", 1050, 0.6e9, 0.015, 1.2, 0, 0.15, false, 5e7 } },
    };
    return m;
}
static const std::map<std::string, ShellMat>& SHELL_MATS()
{
    static const std::map<std::string, ShellMat> m = {
        { "maple", { "Maple", 705, 12.6e9, 40, 0.35 } }, { "birch", { "Birch", 670, 13.9e9, 45, 0.30 } },
        { "mahogany", { "Mahogany", 590, 10.1e9, 32, 0.45 } }, { "oak", { "Oak", 760, 12.5e9, 38, 0.35 } },
        { "walnut", { "Walnut", 640, 11.6e9, 36, 0.40 } }, { "bubinga", { "Bubinga", 890, 18e9, 48, 0.28 } },
        { "keyaki", { "Keyaki (zelkova)", 690, 11e9, 40, 0.35 } }, { "log", { "Carved hardwood log", 800, 12e9, 35, 0.40 } },
        { "mango", { "Mango / sheesham", 650, 10e9, 32, 0.42 } }, { "glass", { "Glass", 2500, 70e9, 900, 0.04 } },
        { "slate", { "Slate / stone", 2750, 45e9, 220, 0.08 } }, { "rosewood", { "Honduras rosewood", 1030, 21e9, 170, 0.20 } },
        { "padauk", { "Padauk", 760, 13e9, 85, 0.28 } }, { "bamboo", { "Bamboo", 700, 17e9, 50, 0.25 } },
        { "gourd", { "Gourd / calabash", 450, 4e9, 18, 0.50 } }, { "clay", { "Clay (terracotta)", 1900, 18e9, 70, 0.15 } },
        { "acrylic", { "Acrylic", 1190, 3.2e9, 22, 0.10 } }, { "fiberglass", { "Fiberglass", 1850, 20e9, 60, 0.12 } },
        { "aluminum", { "Aluminum", 2700, 69e9, 450, 0.05 } }, { "steel", { "Steel", 7850, 200e9, 600, 0.05 } },
        { "brass", { "Brass", 8500, 100e9, 500, 0.05 } }, { "bronze", { "Bronze", 8800, 110e9, 700, 0.05 } },
        { "copper", { "Copper", 8960, 117e9, 400, 0.05 } },
    };
    return m;
}
static const std::map<std::string, HoopMat>& HOOPS()
{
    static const std::map<std::string, HoopMat> m = {
        { "triple", { "Steel triple-flange", 200e9, 7850, 0.006, 6e-5, 250 } },
        { "diecast", { "Die-cast zinc", 96e9, 6600, 0.010, 1.6e-4, 90 } },
        { "wood", { "Wood hoop", 12e9, 700, 0.015, 4.5e-4, 25 } },
        { "none", { "None (rope / tacked)", 0, 0, 0, 0, 0 } },
    };
    return m;
}
const Mallet BRUSH_MALLET = { "Brush (wire)", 0.012, 0.0009, 1.8, 0.03, 0.3, 4, {}, 0.02, true, false };
const Mallet BOW_MALLET = { "Bow (cymbals & gongs)", 0.05, 0.002, 2, 0.004, 0.3, 1, {}, 0, false, true };
static const std::map<std::string, Mallet>& MALLETS()
{
    static const std::map<std::string, Mallet> m = {
        { "stick",     { "Stick (wood tip)", 0.030, 0.00030, 1.5, 0.004, 0.2, 7, { { 1250, 9, 1 }, { 3300, 10, 0.5 }, { 6400, 12, 0.25 } }, 0.17 } },
        { "stick_nyl", { "Stick (nylon tip)", 0.030, 0.00024, 1.5, 0.003, 0.15, 7, { { 1300, 9, 0.8 }, { 3500, 10, 0.6 }, { 7200, 12, 0.35 } }, 0.18 } },
        { "rods",      { "Rods (dowel bundle)", 0.020, 0.00060, 1.7, 0.009, 0.25, 6, { { 900, 5, 0.6 }, { 2400, 6, 0.4 }, { 5200, 7, 0.3 } }, 0.14 } },
        { "felt_beat", { "Kick beater (felt)", 0.080, 0.0020, 2.5, 0.025, 0.4, 5, { { 1700, 2.2, 1.6 }, { 3400, 2.5, 0.7 } }, 0.45 } },
        { "plas_beat", { "Kick beater (plastic)", 0.080, 0.0007, 1.8, 0.022, 0.25, 5, { { 2700, 3, 0.55 }, { 4600, 3.5, 0.35 } }, 0.22 } },
        { "soft_mal",  { "Soft felt mallet", 0.040, 0.0030, 2.6, 0.016, 0.3, 4, {}, 0.05 } },
        { "hard_mal",  { "Hard felt mallet", 0.040, 0.0011, 2.2, 0.012, 0.25, 4.5, { { 1800, 3, 0.2 } }, 0.06 } },
        { "bachi",     { "Bachi (heavy wood)", 0.150, 0.0008, 1.5, 0.012, 0.3, 9, { { 650, 8, 1 }, { 1800, 9, 0.5 }, { 3500, 10, 0.25 } }, 0.1 } },
        { "tipper",    { "Tipper / beater stick", 0.020, 0.0005, 1.6, 0.006, 0.25, 6, { { 1500, 8, 0.7 }, { 4100, 9, 0.4 } }, 0.2 } },
        { "pan_stick", { "Pan stick (rubber tip)", 0.035, 0.0010, 2.0, 0.008, 0.15, 5, { { 2600, 3, 0.15 } }, 0.009 } },
        { "yarn",      { "Yarn mallet (marimba)", 0.035, 0.0018, 1.4, 0.013, 0.25, 4.5, {}, 0.01 } },
        { "xylo",      { "Hard mallet (xylophone)", 0.028, 0.0008, 1.8, 0.006, 0.15, 5, { { 3200, 4, 0.08 } }, 0.03 } },
        { "palm",      { "Hand - palm (bass)", 0.400, 0.0040, 2.0, 0.045, 0.4, 5, {}, 0.03 } },
        { "fingers",   { "Hand - fingers (tone)", 0.080, 0.0015, 2.0, 0.015, 0.3, 5, { { 2200, 1.2, 0.3 } }, 0.024 } },
        { "slap",      { "Hand - slap", 0.050, 0.0006, 1.8, 0.010, 0.2, 6, { { 2600, 1.2, 0.5 }, { 5200, 1.5, 0.3 } }, 0.02 } },
    };
    return m;
}
static const std::map<std::string, Alloy>& ALLOYS()
{
    static const std::map<std::string, Alloy> m = {
        { "b20", { "B20 bronze (cast)", 8600, 110e9, 0.00022 } }, { "b12", { "B12 bronze", 8650, 112e9, 0.00026 } },
        { "b8", { "B8 bronze (sheet)", 8700, 115e9, 0.0003 } }, { "bellmetal", { "Bell metal (B22)", 8600, 105e9, 0.00012 } },
        { "brass", { "Brass", 8450, 100e9, 0.00045 } }, { "nickel", { "Nickel silver", 8700, 125e9, 0.00035 } },
        { "steel", { "Stainless steel", 7900, 195e9, 0.00025 } }, { "aluminum", { "Aluminum", 2700, 69e9, 0.0004 } },
        { "titanium", { "Titanium", 4500, 110e9, 0.0002 } }, { "copper", { "Copper", 8960, 117e9, 0.0006 } },
    };
    return m;
}
template <class M> static const typename M::mapped_type* findIn(const M& m, const std::string& k) { auto it = m.find(k); return it == m.end() ? nullptr : &it->second; }
const HeadMat* headMat(const std::string& k) { return findIn(HEAD_MATS(), k); }
const ShellMat* shellMat(const std::string& k) { return findIn(SHELL_MATS(), k); }
const HoopMat* hoopMat(const std::string& k) { return findIn(HOOPS(), k); }
const Alloy* alloy(const std::string& k) { return findIn(ALLOYS(), k); }
const Mallet* mallet(const std::string& k)
{
    if (k == "brush") return &BRUSH_MALLET;
    if (k == "bow") return &BOW_MALLET;
    return findIn(MALLETS(), k);
}
static const Mallet* malletOr(const Json& cfg) { const Mallet* m = mallet(cfg.str("mallet")); return m ? m : &MALLETS().at("stick"); }

double midiHz(double n) { return 440 * std::pow(2.0, (n - 69) / 12); }

// ---------- head modal analysis ----------
static void harmonize(std::vector<Mode>& modes, double amt)
{
    if (!(amt > 0)) return;
    std::vector<int> base;
    for (int i = 0; i < (int) modes.size(); i++) if (modes[i].orient == 0) base.push_back(i);
    std::stable_sort(base.begin(), base.end(), [&](int x, int y) { return modes[x].f < modes[y].f; });
    if (base.size() > 6) base.resize(6);
    if (base.empty()) return;
    double f0 = modes[base[0]].f;
    for (size_t k = 0; k < base.size(); k++) {
        const Mode& b = modes[base[k]];
        double r = std::pow((k + 1) * f0 / b.f, amt), bm = b.m, bn = b.n;
        for (auto& md : modes) if (md.m == bm && md.n == bn) { md.w *= r; md.f *= r; }
    }
    std::stable_sort(modes.begin(), modes.end(), [](const Mode& x, const Mode& y) {
        int a = x.m == 0 ? 0 : 1, b = y.m == 0 ? 0 : 1; if (a != b) return a < b; return x.f < y.f; });
}

static Head headModes(const Json& head, const HeadMat* matOverride, double a, bool full, double pillow, double sign)
{
    const HeadMat* hm = matOverride ? matOverride : headMat(head.str("material"));
    if (!hm) hm = headMat("mylar_clear");
    double h = jmax(0.03, head.num("thickness")) * 1e-3;
    double sigma = hm->rho * h + hm->coat;
    double D = hm->E * h * h * h / (12 * (1 - NU * NU));
    double T = jmax(20, head.num("tension"));
    if (hm->ys) { double Tcap = hm->ys * h; T = Tcap * std::tanh(T / Tcap); }
    double even = head.nn("evenness", 0.9), muff = head.orv("muffle", 0);
    static const double AIRK[] = { 2.0, 1.6, 1.3, 1.15, 1.05, 1, 1, 1, 1, 1, 1 };
    static const double OUTK[] = { 1, 0.92, 0.84, 0.76, 0.7, 0.65, 0.6, 0.6, 0.6, 0.6, 0.6 };
    Head H; auto& modes = H.modes;
    bool lite = head.truthy("lite"); int mTop = full ? (lite ? 5 : MMAX) : 0, nTop = lite ? 5 : NMAX, NPX = lite ? 18 : NPROXY;
    for (int m = 0; m <= mTop; m++) for (int n = 0; n < nTop; n++) {
        double j = BT().ZEROS[m][n], k = j / a;
        double sigE = sigma + AIRK[m] * RHO * a / j;
        double kb = (j + 0.78) / a;
        double memb = T * k * k, bend = D * kb * kb * kb * kb;
        double w = std::sqrt((memb + bend) / sigE), f = w / TAU;
        if (f > 12000) continue;
        double Jn = BT().JNEXT[m][n];
        double Nn = (m == 0 ? 1 : 0.5) * PI * a * a * Jn * Jn;
        double M = sigE * Nn;
        double ka = w / C * a, x2 = std::pow(ka, 2 * (m + 1));
        double g = std::pow(0.45, m) * x2 / (1 + x2);
        double alpha = 0.6 + 0.4 * hm->eta * w * (1 + 0.6 * hm->hf * f / 2000) + 0.025 * RHO * C / sigE * g
            + muff * (14 + 9 * m + 0.0015 * w) + (m == 0 ? pillow * 35 : pillow * 8);
        double S = m == 0 ? TAU * a * a * Jn / j : 0;
        double rimF = m == 0 ? sign * T * TAU * j * Jn : 0;
        Mode base; base.m = m; base.n = n + 1; base.j = j; base.k = k; base.w = w; base.f = f; base.M = M; base.alpha = alpha; base.S = S; base.rimF = rimF;
        base.outW = std::sqrt(Nn) / a * OUTK[m]; base.tmw = k * k * Nn / (PI * a * a); base.frac = memb / (memb + bend); base.orient = 0;
        if (m == 0) modes.push_back(base);
        else for (int o = 0; o < 2; o++) {
            double det = 1 + (o ? 1 : -1) * (1 - even) * 0.015 * (0.3 + 0.7 * hashf(m, n));
            Mode md = base; md.w = w * det; md.f = f * det; md.orient = o; modes.push_back(md);
        }
    }
    harmonize(modes, head.orv("harmonic", 0));
    if (full && !head.truthy("noProxy")) {
        double fTop = 0; for (auto& md : modes) if (md.f > fTop) fTop = md.f;
        double fHi = 11500, cw = std::sqrt(T / sigma);
        if (fTop < fHi * 0.9) {
            auto Nf = [&](double f) { return PI * a * a * PI * f * f / (cw * cw); };
            double lo = fTop * 1.04, r = std::pow(fHi / lo, 1.0 / NPX), prevN = Nf(lo);
            double sigA = sigma + RHO * a / 30;
            for (int pi = 0; pi < NPX; pi++) {
                double fc = lo * std::pow(r, pi + 0.5 + 0.35 * (hashf(pi, 7) - 0.5));
                double fEdge = lo * std::pow(r, pi + 1), Nnow = Nf(fEdge), grp = jmax(1, Nnow - prevN); prevN = Nnow;
                double wp = TAU * fc, kp = wp / cw, Np = 0.25 * PI * a * a / jmax(4, kp * a) * 2;
                double alp = 0.6 + 0.4 * hm->eta * wp * (1 + 0.6 * hm->hf * fc / 2000) + muff * (40 + 0.0015 * wp);
                Mode md; md.m = 99; md.n = pi; md.j = kp * a; md.k = kp; md.w = wp; md.f = fc; md.M = sigA * Np; md.alpha = alp;
                md.outW = 0.55 * std::sqrt(Np) / a; md.proxy = true; md.a0 = a;
                md.amp = std::sqrt(grp) * 0.5 * (hashf(pi, 11) < 0.5 ? -1 : 1); md.ph = hashf(pi, 13) * TAU;
                modes.push_back(md);
            }
        }
    }
    H.sigma = sigma; H.T = T; H.tmCoef = hm->E * h / (2 * (1 - NU) * T); H.a = a; H.metal = hm->metal;
    return H;
}

static std::vector<Res> shellModes(const ShellMat& SM, double R, double L, double h, double Ms)
{
    std::vector<Res> out; double lam = PI * R / L, l2 = lam * lam, cp = std::sqrt(SM.E / (SM.rho * (1 - NU * NU)));
    for (int n = 2; n <= 14; n++) {
        double s = n * n + l2;
        double Om2 = l2 * l2 * (1 - NU * NU) / (s * s) + h * h / (12 * R * R) * s * s;
        double w = std::sqrt(Om2) * cp / R;
        if (w / TAU < 11000) out.push_back({ w, Ms / 2, w / (2 * SM.Q) + 6, jmin(1, std::pow(w / (TAU * 1500), 2)) });
    }
    std::stable_sort(out.begin(), out.end(), [](const Res& x, const Res& y) { return x.w < y.w; });
    if (out.size() > 8) out.resize(8);
    return out;
}
static std::vector<Res> ringModes(const HoopMat* HP, double R)
{
    std::vector<Res> out; if (!HP || !HP->E) return out;
    double cst = std::sqrt(HP->E / HP->rho) * HP->heff / std::sqrt(12.0) / (R * R);
    double M = HP->rho * TAU * R * HP->area;
    for (int n = 2; n <= 11; n++) {
        double w = cst * n * (n * n - 1) / std::sqrt((double) n * n + 1);
        if (w / TAU < 11000) out.push_back({ w, M / 2, w / (2 * HP->Q) + 4 + 600 / (1 + w / (TAU * 150)), jmin(1, std::pow(w / (TAU * 1500), 2)) });
    }
    return out;
}

// ---------- tuned bars / tongues ----------
static std::vector<double> scaleNotes(double root, const std::string& scale, int count)
{
    static const std::map<std::string, std::vector<int>> S = {
        { "major", { 0, 2, 4, 5, 7, 9, 11 } }, { "minor", { 0, 2, 3, 5, 7, 8, 10 } }, { "pent_major", { 0, 2, 4, 7, 9 } },
        { "pent_minor", { 0, 3, 5, 7, 10 } }, { "akebono", { 0, 2, 3, 7, 8 } }, { "hijaz", { 0, 1, 4, 5, 7, 8, 10 } },
        { "dorian", { 0, 2, 3, 5, 7, 9, 10 } }, { "celtic", { 0, 2, 3, 5, 7, 10 } }, { "blues", { 0, 3, 5, 6, 7, 10 } },
        { "whole", { 0, 2, 4, 6, 8, 10 } }, { "chromatic", { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } } };
    auto it = S.find(scale); const auto& iv = it == S.end() ? S.at("major") : it->second;
    std::vector<double> out; int L = (int) iv.size();
    for (int i = 0; (int) out.size() < count; i++) out.push_back(root + 12 * (i / L) + iv[i % L]);
    return out;
}
static const double BAR_BETA[] = { 4.730, 7.853, 10.996, 14.137 }, BAR_SIG[] = { 0.9825, 1.0008, 0.99997, 1 };
struct BarProps { double gE, hx, grain, clk, qK, sus; };
static BarProps barProps(const ShellMat& M)
{
    const std::string& n = M.name; bool metal = M.E > 50e9 && M.rho > 4000;
    auto has = [&](const char* s) { return n.find(s) != std::string::npos; };
    if (has("Glass")) return { 0.40, -0.35, 0.05, 0.035, 0, 0 };
    if (has("Slate") || has("stone")) return { 0.40, 0.05, 0.35, 0.035, 0, 0 };
    if (has("Clay") || has("clay") || has("terracotta") || has("Terracotta")) return { 0.40, 0.25, 0.7, 0.035, 1.7, 0 };
    if (has("Acrylic")) return { 0.36, 0.25, 0.05, 0.06, 0, 0 };
    if (has("Fiberglass")) return { 0.15, 0.0, 0.05, 0.05, 0, 0 };
    if (metal || has("Aluminum")) return { 0.38, -0.6, 0.0, 0.06, 0, 0 };
    if (has("Bamboo")) return { 0.05, -0.2, 0.25, 0.03, 0, 0 };
    if (has("Gourd")) return { 0.08, 0.3, 0.4, 0.03, 0, 0 };
    return { 0.07, -0.3, 0.15, 0.02, 0, 0.55 };
}
static const ShellMat& tunedMat(const Json& sp, const ShellMat& SM)
{
    std::string mk = sp.str("material");
    const ShellMat* t = (mk == "__shell") ? nullptr : shellMat(mk);
    return t ? *t : SM;
}
static Head barModel(const Json& cfg, const ShellMat& SM, double a)
{
    const Json& sp = cfg.get("special"); const ShellMat& TM = tunedMat(sp, SM);
    double h = jmax(1, sp.orv("thickness", 20)) * 1e-3;
    int cnt = toInt32(sp.num("count")); if (!cnt) cnt = 52;
    auto notes = scaleNotes(sp.nn("root", 45), sp.truthy("scale") ? sp.str("scale") : "chromatic", (int) jmax(1, jmin(64, cnt)));
    int N = (int) notes.size(); double amt = sp.nn("overtone", 0.9); bool xylo = sp.str("tuning") == "xylo"; double res = sp.nn("resonators", 0.8);
    double even = sp.nn("evenness", 0.98), muff = sp.orv("muffle", 0), cE = std::sqrt(TM.E / TM.rho);
    const double raw[] = { 1, 2.756, 5.404, 8.933 };
    const double tgtX[] = { 1, 3, 6, 10 }, tgtM[] = { 1, 4, 9.8, 16 }, oKX[] = { 1, 0.42, 0.2, 0.1 }, oKM[] = { 1, 0.3, 0.14, 0.07 };
    const double* tgt = xylo ? tgtX : tgtM; const double* oK = xylo ? oKX : oKM;
    Head H; bool metal = TM.E > 50e9; BarProps BP = barProps(TM); double G = TM.E * BP.gE;
    auto loss = [&](double f) { return std::pow(jmax(1, f / 500), BP.hx); };
    double qK = BP.qK ? BP.qK : 1;
    for (int p = 0; p < N; p++) {
        double note = notes[p], f1 = midiHz(note) * (1 + (1 - even) * 0.03 * (hashf(p, 5) - 0.5));
        double under = 1 - 0.55 * amt;
        double L = std::sqrt(1.028 * h * cE * under / f1);
        double w = jmax(0.025, jmin(0.075, sp.orv("width", 5.5) * 0.01 * (1.15 - 0.3 * p / jmax(1, N - 1))));
        double th = -PI / 2 + TAU * p / N, hw = 0.4 * TAU / N;
        Tongue t; t.idx = p; t.note = note; t.f = f1; t.L = L; t.w = w; t.th = th; t.hw = hw; t.rb = 0.94; t.ln = 0.8; t.bar = true; t.tooLong = L > 1.3;
        double mass = TM.rho * w * h * L * (0.7 + 0.3 * (1 - amt));
        for (int k = 0; k < 4; k++) {
            double f = f1 * std::pow(raw[k], 1 - amt) * std::pow(tgt[k], amt) * (k ? 1 + BP.grain * 0.06 * (hashf(p, 60 + k) - 0.5) : 1); if (f > 11000) continue;
            double wv = TAU * f, x = wv / C * std::sqrt(w * L), eff = x * x / (1 + x * x);
            double tube = k == 0 ? res : (xylo && k == 1 ? 0.6 * res : 0);
            double alpha = jmin(wv / (2 * TM.Q * qK) * loss(f) * (k == 0 ? (BP.sus ? BP.sus : 1) : 1), k == 0 ? (BP.sus ? 12 : 22) : 1e9) + 0.35 + tube * 0.7 + muff * (10 + 0.002 * wv);
            Mode md; md.m = p; md.n = k + 1; md.bar = true; md.tg = p; md.k = BAR_BETA[k] / L; md.w = wv; md.f = f; md.M = mass / 4; md.alpha = alpha;
            md.outW = std::sqrt(eff + 0.03) * oK[k] * (1 + 1.8 * tube) * (metal ? 0.8 : 1) * std::pow(jmax(1, f1 / 440), 0.3); md.partial = k;
            H.modes.push_back(md);
        }
        double hb = h * (1 - 0.45 * amt), J = w * hb * hb * hb * (1.0 / 3 - 0.21 * jmin(1, hb / w)), Ip = w * hb * (w * w + hb * hb) / 12, cT = std::sqrt(G * J / (TM.rho * Ip));
        for (int nt = 1; nt <= 2; nt++) {
            double ft = nt * cT / (2 * L) * (1 + BP.grain * 0.05 * (hashf(p, 70 + nt) - 0.5)); if (ft > 11000 || ft < f1 * 1.2) continue;
            double wt = TAU * ft, xt = wt / C * std::sqrt(w * L), et = xt * xt / (1 + xt * xt);
            Mode md; md.m = p; md.n = 10 + nt; md.bar = true; md.tg = p; md.k = nt * PI / L; md.w = wt; md.f = ft; md.M = mass / 4;
            md.alpha = jmin(wt / (2 * TM.Q * qK) * loss(ft), 1e9) * 1.3 + 0.5 + muff * (10 + 0.002 * wt);
            md.outW = std::sqrt(et + 0.03) * (BP.gE < 0.2 ? 0.15 : 0.3) * std::pow(jmax(1, f1 / 440), 0.3); md.partial = 10 + nt;
            H.modes.push_back(md);
        }
        t.clk = BP.clk;
        H.tongues.push_back(t);
    }
    H.sigma = TM.rho * h; H.T = 0; H.tmCoef = 0; H.a = a;
    return H;
}
static double barShape(const Tongue& t, const Mode& md, double r, double th)
{
    double d = th - t.th; d = std::atan2(std::sin(d), std::cos(d));
    if (d > t.hw || d < -t.hw) return 0;
    double x = (t.rb - r) / t.ln; if (x < 0 || x > 1) return 0;
    if (md.partial >= 10) return (d / t.hw) * std::cos((md.partial - 10) * PI * x);
    int k = md.partial; double b = BAR_BETA[k] * x, sg = BAR_SIG[k];
    return 0.5 * (std::cosh(b) + std::cos(b) - sg * (std::sinh(b) + std::sin(b)));
}
static Head tongueModel(const Json& cfg, const ShellMat& SM, double a)
{
    const Json& sp = cfg.get("special"); const ShellMat& TM = tunedMat(sp, SM);
    double h = jmax(0.3, sp.orv("thickness", 2)) * 1e-3;
    int cnt = toInt32(sp.num("count")); if (!cnt) cnt = 9;
    auto notes = scaleNotes(sp.nn("root", 50), sp.truthy("scale") ? sp.str("scale") : "minor", (int) jmax(1, jmin(36, cnt)));
    int N = (int) notes.size(); double cbar = std::sqrt(TM.E * h * h / (12 * TM.rho)), amt = sp.nn("overtone", 0.7);
    double even = sp.nn("evenness", 0.97), muff = sp.orv("muffle", 0), rb = 0.94;
    std::vector<int> order; for (int i = 0; i < N; i += 2) order.push_back(i);
    for (int j = (N - 1) - ((N - 1) % 2 == 0 ? 1 : 0); j > 0; j -= 2) order.push_back(j);
    Head H;
    for (int p = 0; p < N; p++) {
        int ni = order[p]; double note = notes[ni];
        double f1 = midiHz(note) * (1 + (1 - even) * 0.03 * (hashf(ni, 5) - 0.5));
        double L = std::sqrt(3.516 * cbar / (TAU * f1));
        double th = -PI / 2 + TAU * p / N;
        double hw = jmin(0.40 * TAU / N, (sp.orv("width", 3.5) * 0.01 / 2) / (rb * a));
        double w = 2 * hw * rb * a, ln = jmin(L / a, 0.9);
        Tongue t; t.idx = ni; t.note = note; t.f = f1; t.L = L; t.w = w; t.th = th; t.hw = hw; t.rb = rb; t.ln = ln; t.tooLong = L / a > 0.9;
        H.tongues.push_back(t);
        double rawT = jmax(1.3, 0.96 * L / w);
        const double raw[] = { 1, rawT, 6.267, 17.55 }, tgt[] = { 1, 2, 3, 6 }, sK[] = { 0.39, 0, 0.11, 0.06 }, oK[] = { 1, 0.55, 0.9, 0.8 };
        double mass = TM.rho * w * h * L;
        for (int k = 0; k < 4; k++) {
            double r = std::pow(raw[k], 1 - amt) * std::pow(tgt[k], amt), f = f1 * r;
            if (f > 11000) continue;
            double wv = TAU * f, x = wv / C * std::sqrt(w * L), eff = x * x / (1 + x * x);
            Mode md; md.m = ni; md.n = k + 1; md.tg = p; md.k = 1.875 * (k + 1) / L; md.w = wv; md.f = f; md.M = mass / 4; md.S = sK[k] * w * L;
            md.alpha = jmin(wv / (2 * TM.Q) + 0.3 * f / 1000, k == 0 ? 16 : k == 1 ? 30 : 1e9) + 0.5 + muff * (12 + 0.002 * wv);
            md.outW = std::sqrt(eff + 0.02) * oK[k]; md.partial = k;
            H.modes.push_back(md);
        }
    }
    H.sigma = TM.rho * h; H.T = 0; H.tmCoef = 0; H.a = a;
    return H;
}
static double tongueShape(const Tongue& t, const Mode& md, double r, double th)
{
    double d = th - t.th; d = std::atan2(std::sin(d), std::cos(d));
    if (d > t.hw || d < -t.hw) return 0;
    double x = (t.rb - r) / t.ln; if (x < 0 || x > 1) return 0;
    double lat = d / t.hw;
    switch (md.partial) {
        case 0: return std::pow(x, 1.9);
        case 1: return x * lat;
        case 2: return x * x * (1 - 1.75 * x) * 1.3;
        default: return x * x * (1 - 3.2 * x + 2.5 * x * x) * 2;
    }
}
static HeadMat shellHeadMat(const ShellMat& SM)
{
    bool metal = SM.E > 50e9, wood = SM.rho < 1000 && SM.E < 20e9;
    return { SM.name + " plate", SM.rho, SM.E, 1 / SM.Q, metal ? 0.05 : wood ? 0.6 : 0.35, 0, metal ? 1.0 : wood ? 4 : SM.rho > 1500 ? 6 : 3, metal, 0 };
}

// ---------- headless bodies ----------
static double bodyAmp(const Mode& md, double u)
{
    switch (md.body) {
        case Body::Bowl: return std::pow(jmax(0, u), 0.8 * md.m);
        case Body::GBowl: { double v = (u - 0.3) / 0.7; return v <= 0 ? 0 : std::pow(v, 0.8 * md.m); }
        case Body::Stem: return u < 0.4 ? 1 - u / 0.4 : 0;
        default: return md.n == 1 ? 0.65 + 0.35 * u : (2 * u - 1);
    }
}
static std::vector<Mode> bodyModes(const Json& cfg, const ShellMat& SM)
{
    const Json& sh = cfg.get("shell"); double a = sh.num("diameter") * 0.0127, H = jmax(0.005, sh.num("depth") * 0.0254);
    double h = jmax(0.4, sh.orv("thickness", 3)) * 1e-3, even = sh.nn("evenness", 0.9), muff = sh.orv("muffle", 0);
    double cbar = std::sqrt(SM.E / SM.rho); std::vector<Mode> out;
    auto ring = [&](double R, double factor, double mass, Body kind, int fam, int nmax) {
        for (int n = 2; n <= (nmax ? nmax : 12); n++) {
            double w = factor * cbar * h / std::sqrt(12.0) / (R * R) * n * (n * n - 1) / std::sqrt((double) n * n + 1);
            if (w / TAU > 11000) break;
            double x = w / C * R, eff = x * x / (1 + x * x);
            double alpha = w / (2 * SM.Q) + 1.2 + 0.01 * RHO * C / (SM.rho * h) * eff + muff * (25 + 0.004 * w);
            for (int o = 0; o < 2; o++) {
                double det = 1 + (o ? 1 : -1) * (1 - even) * 0.02 * (0.3 + 0.7 * hashf(n, fam + 3));
                Mode md; md.m = n; md.n = fam; md.j = n; md.k = n / R; md.w = w * det; md.f = w * det / TAU; md.M = mass / 2; md.alpha = alpha;
                md.outW = std::sqrt(eff) * (kind == Body::Stem ? 0.7 : 1); md.orient = o; md.body = kind;
                out.push_back(md);
            }
        }
    };
    std::string shape = sh.str("shape");
    if (shape == "kettle") {
        double D = jmax(0.02, (sh.truthy("bowlDepth") ? sh.num("bowlDepth") : sh.num("depth")) * 0.0254);
        ring(a, 1.3 * std::sqrt(1 + 0.5 * a / D), SM.rho * h * (PI * a * a + TAU * a * D) * 0.5, Body::Bowl, 1, 0);
    } else if (shape == "goblet") {
        double D2 = jmax(0.02, sh.orv("bowlDepth", 6) * 0.0254), rs = jmax(0.005, sh.orv("portDiam", 2) * 0.0127), Ls = jmax(0.01, sh.orv("portLen", 6) * 0.0254);
        ring(a, 1.3 * std::sqrt(1 + 0.5 * a / D2), SM.rho * h * (PI * a * a + TAU * a * D2) * 0.5, Body::GBowl, 1, 0);
        ring(rs, 1, SM.rho * h * TAU * rs * Ls, Body::Stem, 2, 8);
    } else {
        double Ms = SM.rho * h * TAU * a * H;
        ring(a, 1, Ms, Body::Tube, 1, 0);
        if (H > 0.3 * a) ring(a, std::sqrt(1 + 24 * (1 - NU) * std::pow(a / H, 2) / 9), Ms, Body::Tube, 2, 8);
    }
    std::stable_sort(out.begin(), out.end(), [](const Mode& x, const Mode& y) { return x.f < y.f; });
    return out;
}

// ---------- metal ----------
static double cymHF(double f, const std::string& piece)
{
    double e = piece == "splash" ? 0.45 : piece == "ride" ? 0.2 : 0.1, k = 1;
    return k * (f <= 2000 ? 1 : f <= 8000 ? std::pow(2000 / f, e) : std::pow(0.25, e) * std::pow(f / 8000, 1.8));
}
double metalShape(const Mode& md, double r, double th)
{
    double ang = std::cos(md.m * th + md.phi);
    if (md.ms == MS::Plate) {
        double x = md.lam * jmax(0, r), m = md.m, R;
        if (x < m) R = std::pow(x / m, 0.6 * m) * std::cos(-PI / 4);
        else R = std::cos(x - m * PI / 2 - PI / 4 - (m ? std::sqrt(x * x - m * m) - x + m * std::acos(jmin(1, m / x)) : 0)) * std::sqrt((m + 1.5) / (x + 1.5));
        if (md.rb > 0 && r < md.rb) R *= 0.25 + 0.75 * r / md.rb;
        if (md.taper) R *= 1 + 0.5 * md.taper * r * r;
        return R * ang;
    }
    if (md.ms == MS::Bell) {
        double u = r / jmax(0.01, md.rb);
        return u > 1.25 ? 0.003 * ang : u > 1 ? (0.55 + 0.45 * std::sin(PI * 0.9)) * (1 - (u - 1) / 0.25) * ang : (0.55 + 0.45 * std::sin(PI * u * 0.9)) * ang;
    }
    if (md.ms == MS::Bowl) return std::pow(jmax(0, r), 0.7 * md.m) * ang;
    if (md.ms == MS::Proxy) {
        double cupK = md.rb > 0.02 && r < md.rb * 1.1 ? std::pow(r / (md.rb * 1.1), 3) * 0.3 : 1;
        return md.amp * jmax(0, r) * cupK * std::sin(md.k * r * 0.12 + md.phi + 3 * th);
    }
    return 0;
}

double modeShape(const Model& model, const Mode& md, double r, double th)
{
    if (md.ms != MS::None) return metalShape(md, r, th);
    if (md.bar) return barShape(model.tongues[md.tg], md, r, th);
    if (md.tg >= 0) return tongueShape(model.tongues[md.tg], md, r, th);
    if (md.proxy) { double rr = jmin(1, r); return md.amp * std::sin(md.k * md.a0 * rr * 0.9 + md.ph + 3 * th) * std::sqrt(jmax(0, 1 - rr * rr * rr * rr)); }
    double ang = md.m == 0 ? 1 : (md.orient ? std::sin(md.m * th) : std::cos(md.m * th));
    return (md.body != Body::None ? bodyAmp(md, r) : radial((int) md.m, (int) md.n - 1, r)) * ang;
}

static PlateSet plateSet(const Json& c, const std::string& piece, const std::string& quality, const Json& sp, int which, double budget, double sr)
{
    const Alloy* A = alloy(c.str("alloy")); if (!A) A = alloy("b20");
    double a = jmax(0.03, c.orv("diameter", 16) * 0.0127), h = jmax(0.2, c.orv("thickness", 1)) * 1e-3;
    double taper = c.orv("taper", 0), heff = h * (1 - 0.3 * taper);
    double cbar = std::sqrt(A->E / A->rho), even = c.nn("evenness", 0.92);
    double hammer = c.orv("hammer", 0), lathe = c.nn("lathe", 0.5), holes = c.orv("holes", 0), flange = c.orv("flange", 0);
    bool light = quality == "light", hats = piece == "hihat" || piece == "stack";
    int maxN = (int) jsround((light ? 95 : 170) * budget), nProxy = (int) jsround((light ? 66 : 130) * budget * (hats ? 0.45 : 1));
    double fmax = jmin(15500, 0.3 * (sr ? sr : 44100));
    PlateSet P; auto& modes = P.modes; bool isBellPiece = piece == "bell" || piece == "cowbell";
    double massPlate = A->rho * PI * a * a * heff * (1 - 0.02 * holes);
    bool gong = piece == "tamtam" || piece == "opera" || piece == "nipple";
    double rim = gong ? sp.nn("rim", 0.6) : 0;
    double rb = isBellPiece ? 0 : jmin(0.6, jmax(0, c.orv("bellDia", 0) / jmax(1, c.orv("diameter", 16))));
    double D = A->E * heff * heff * heff / (12 * (1 - NU * NU));
    bool cymPiece = piece == "crash" || piece == "ride" || piece == "splash" || piece == "china" || piece == "trash";
    if (!isBellPiece) {
        double base = std::sqrt(D / (A->rho * heff)) / (a * a);
        double dome = jmax(0.3, c.nn("dome", 20)) * 1e-3, Rc = a * a / (2 * dome);
        double irr = 0.06 * (1 - even) + hammer * 0.05 + flange * 0.12 + holes * 0.012;
        struct Cand { int m, n; double w, lam, thin = 0, lowK = 0; };
        std::vector<Cand> cand;
        for (int m = 0; m <= 120; m++) {
            bool any = false;
            for (int n = 0; n <= 60; n++) {
                if (m < 2 && n == 0) continue;
                double lam = 1.15 * m + PI * n - (m == 0 ? 0.1 : 0.2);
                double wp = base * lam * lam, wc = cbar / Rc / ((1.0 + m * m) * (1 + n));
                double w = std::sqrt(wp * wp + wc * wc);
                if (rim) w *= 1 + rim * 0.6 / (1 + 0.15 * m) * (n == 0 ? 1 : 0.4);
                w *= 1 + irr * (hashf(m, n + 17) - 0.5) * 2;
                if (w / TAU > fmax) break;
                any = true; cand.push_back({ m, n, w, lam });
            }
            if (!any && m > 3) break;
        }
        std::stable_sort(cand.begin(), cand.end(), [](const Cand& x, const Cand& y) { return x.w < y.w; });
        if (light && cymPiece) {
            std::vector<Cand> full(cand.begin(), cand.begin() + std::min(cand.size(), (size_t) jsround(170 * budget))), low, hi, hiK;
            for (auto& c0 : full) (c0.w < TAU * 900 ? low : hi).push_back(c0);
            double room = jmax(8, maxN - (double) low.size()), keep = jmin(1, room / jmax(1, (double) hi.size())), acc = 0;
            for (auto& c0 : hi) { acc += keep; if (acc >= 1) { acc -= 1; hiK.push_back(c0); } }
            for (auto& c0 : hiK) c0.thin = 1 / keep;
            for (auto& c0 : low) c0.lowK = 1.5;
            cand = low; cand.insert(cand.end(), hiK.begin(), hiK.end());
        } else if ((int) cand.size() > maxN) cand.resize(std::max(0, maxN));
        for (auto& cd : cand) {
            double f = cd.w / TAU, k = cd.lam / a;
            double hfLoss = (1 + 0.5 * hammer + 0.6 * flange + 0.1 * holes) * (1 - 0.35 * lathe) * (gong ? 0.45 : 1) * (piece == "hihat" ? 1 + f / 14000 : 1);
            bool cym = !gong && !hats; double hfK = cym ? cymHF(f, piece) : 1;
            double drain = cym ? 1.8 * (piece == "ride" ? 0.3 : piece == "splash" ? 1.8 : 0.25) * std::exp(-f / 900) + (piece == "splash" ? 1.2 : 0) : 0;
            if (cym) drain += (piece == "ride" ? 1.5 : 9) * std::exp(-f / 300);
            double alpha = (gong ? (piece == "opera" ? 0.5 : 0.03) : 0.12) + (piece == "hihat" ? 1 + 8 * std::exp(-f / 1500) : 0) + 0.5 * A->eta * cd.w * hfLoss * hfK + drain + 0.002 * f / 1000 * RHO * C / (A->rho * heff)
                + (cd.m <= 2 && !gong ? 0.5 : 0) + flange * (cd.m < 6 ? 3 : 0.6) + holes * 0.25 + (gong ? 0 : 0.08 + 0.4 * std::pow(14 / jmax(6, c.orv("diameter", 16)), 2));
            int pairs = cd.m > 0 && cd.m <= 6 ? 2 : 1;
            for (int o = 0; o < pairs; o++) {
                double det = pairs == 2 ? 1 + (o ? 1 : -1) * (0.002 + (1 - even) * 0.012) * (0.3 + 0.7 * hashf(cd.m, cd.n + 3)) : 1;
                double phi = pairs == 2 ? (o ? PI / (2.0 * cd.m) : 0) : hashf(cd.m + 7, cd.n) * TAU;
                Mode md; md.m = cd.m; md.n = cd.n; md.w = cd.w * det; md.f = f * det; md.M = massPlate / 4; md.alpha = alpha; md.k = k; md.phi = phi;
                md.ms = MS::Plate; md.rb = rb; md.which = which; md.orient = o; md.taper = taper;
                md.outW = cd.thin ? std::sqrt(cd.thin) : (cd.lowK ? cd.lowK : 1); md.spread = cd.thin ? 0.01 * cd.thin : 0; md.frac = 1; md.lam = cd.lam;
                modes.push_back(md);
            }
        }
        double bellH = c.nn("bellHeight", 15) * 1e-3;
        if (rb > 0.02 && bellH > 0.002) {
            double Rb = rb * a, hb = heff * 1.4, mb = A->rho * hb * TAU * Rb * bellH * 0.8;
            double cupK = piece == "ride" ? 1 : piece == "splash" ? 7 : piece == "crash" ? 2.5 : piece == "china" || piece == "trash" ? 3.5 : 1;
            double cupMin = piece == "ride" ? 6.91 / 4 : (piece == "crash" || piece == "china" || piece == "trash" || piece == "splash") ? 6.91 / 2.5 : 0;
            bool bossTuned = piece == "nipple"; double f0b = bossTuned ? midiHz(sp.nn("bossNote", 45)) : 0;
            const double ratios[] = { 1, 2.0, 2.76, 3.9, 5.1, 6.4, 7.8, 9.3, 11 };
            for (int fam = 0; fam < (bossTuned ? 1 : 2); fam++) for (int bn = 2; bn <= 10; bn++) {
                double wb = bossTuned ? TAU * f0b * ratios[bn - 2] : 1.3 * std::sqrt(1 + 0.5 * Rb / bellH) * cbar * hb / std::sqrt(12.0) / (Rb * Rb) * bn * (bn * bn - 1) / std::sqrt((double) bn * bn + 1) * (fam ? 1.6 + 0.08 * bn : 1);
                if (wb / TAU > fmax) break;
                for (int ob = 0; ob < 2; ob++) {
                    Mode md; md.m = bn; md.n = fam; md.w = wb * (1 + (ob ? 1 : -1) * 0.0015); md.f = wb / TAU; md.M = mb / 2;
                    md.alpha = jmax((0.12 + 0.35 * A->eta * wb * (bossTuned ? 0.5 : 1)) * cupK, cupMin); md.k = bn / Rb; md.phi = ob ? PI / (2.0 * bn) : 0;
                    md.ms = MS::Bell; md.rb = rb; md.which = which; md.orient = ob;
                    md.outW = bossTuned ? (bn == 2 ? 2.6 : bn == 3 ? 1.6 : 1.1) : fam ? 0.9 : 1.3; md.frac = 1; md.cup = true; md.boss = bossTuned && bn <= 3;
                    modes.push_back(md);
                }
            }
        }
    } else {
        double Kb = piece == "bell" ? 0.47 : 0.43, f1 = Kb * h / (a * a) * cbar;
        std::vector<double> R = piece == "bell" ? std::vector<double>{ 0.5, 1, 1.19, 1.5, 2, 2.51, 2.66, 3.01, 4.0, 5.1, 6.2 } : std::vector<double>{ 1, 1.48, 1.86, 2.53, 3.04, 3.8, 4.6, 5.7 };
        double Mb = A->rho * h * TAU * a * a * 1.2;
        for (int i = 0; i < (int) R.size(); i++) {
            double w = TAU * f1 * R[i] * (1 + (1 - even) * 0.03 * (hashf(i, 9) - 0.5) + hammer * 0.02 * (hashf(i, 4) - 0.5)); if (w / TAU > fmax) continue;
            int mm = 2 + i / 2;
            double alpha = (piece == "bell" ? 0.06 : 0.25) + 0.5 * A->eta * w * (piece == "cowbell" ? 4 : 1) * (1 + hammer) + (piece == "cowbell" ? 9 : 0);
            for (int o = 0; o < 2; o++) {
                Mode md; md.m = mm; md.n = i; md.w = w * (1 + (o ? 1 : -1) * 0.0015 * (1 + 3 * (1 - even))); md.f = w / TAU; md.M = Mb / 4; md.alpha = alpha; md.k = mm / a;
                md.phi = o ? PI / (2.0 * mm) : 0; md.ms = MS::Bowl; md.which = which; md.orient = o; md.outW = 1; md.frac = 1;
                modes.push_back(md);
            }
        }
    }
    if (!isBellPiece) {
        double fTop = 0; for (auto& md : modes) if (md.ms == MS::Plate && md.f > fTop) fTop = md.f;
        if (hats) fTop = jmax(fTop, 4200);
        if (fTop < fmax * 0.85) {
            int NP = nProxy; double lo = fTop * 1.03, r2 = std::pow(fmax / lo, 1.0 / NP);
            double dens = (PI * a * a) / (4 * PI) * std::sqrt(A->rho * heff / D);
            for (int pi = 0; pi < NP; pi++) {
                bool cymR = !gong && !hats;
                double fc = lo * std::pow(r2, pi + 0.5 + (cymR ? 0.9 : 0.3) * (hashf(pi, 21) - 0.5)), grp = jmax(1, dens * TAU * fc * (r2 - 1));
                double wv = TAU * fc; bool cymP = cymR; double hfK2 = cymP ? cymHF(fc, piece) : 1, splX = piece == "splash" ? 2.2 : 0;
                Mode md; md.m = 50; md.n = pi; md.w = wv; md.f = fc; md.M = massPlate / 4;
                md.alpha = 0.2 + 0.5 * A->eta * wv * hfK2 * (1 + 0.5 * hammer + 0.6 * flange + 0.1 * holes) * (1 - 0.35 * lathe) * (piece == "hihat" ? 1 + fc / 14000 : 1) + flange * 0.6 + holes * 0.25 + (gong ? 0 : 0.15) + splX;
                md.k = std::sqrt(wv / std::sqrt(D / (A->rho * heff))); md.phi = hashf(pi, 23) * TAU; md.ms = MS::Proxy; md.spread = r2 - 1;
                md.amp = std::sqrt(grp) * 1.4 * (cymP && fc > 7000 ? std::pow(7000 / fc, 1.5) : 1) * (cymP ? 0.3 + 1.4 * hashf(pi, 27) * hashf(pi, 28) + 0.5 * hashf(pi, 29) : 1);
                // engine.js: a trailing comment swallows `rb`, `which` and `orient` here, so proxies leave them undefined
                md.rb = 0; md.which = -1; md.orient = -1;
                md.outW = 1; md.frac = 0; md.proxy = true;
                modes.push_back(md);
            }
        }
    }
    bool cymO = !gong && !hats && !isBellPiece;
    for (auto& md : modes) {
        if (cymO && md.ms == MS::Plate) md.outW *= md.f / (md.f + 120);
        double x = md.w / C * a * 0.7, mm = md.boss ? 0 : md.ms == MS::Proxy ? 3 : jmin(md.m, cymO && md.ms == MS::Plate ? 1 : 3), p = std::pow(x, 2 * (mm + 1));
        md.outW *= std::sqrt(p / (1 + p));
    }
    P.a = a; P.mass = massPlate; P.A = A; P.heff = heff; P.cbar = cbar; P.rb = rb; P.D = D;
    return P;
}

static std::shared_ptr<Model> buildMetalModel(const Json& cfg, double sr)
{
    Json sp = cfg.get("special"); std::string piece = sp.truthy("piece") ? sp.str("piece") : "crash";
    std::string q = cfg.truthy("lite") ? "light" : (sp.truthy("quality") ? sp.str("quality") : "full");
    std::string spPiece = sp.str("piece");
    double kb = cfg.truthy("lite") ? (spPiece == "hihat" || spPiece == "stack" ? 0.55 : 0.7) : 1;
    bool pair = piece == "hihat" || piece == "stack";
    if (pair) {
        auto cap = [](const Json& pl, double mx) { if (pl.truth() && pl.num("thickness") > mx) { Json o = pl; o.set("thickness", Json::number(mx)); return o; } return pl; };
        Json top = cap(sp.get("top"), 3), bottom = cap(sp.get("bottom"), 2);
        sp = sp.merged(Json::object()); sp.set("top", top); sp.set("bottom", bottom);
    }
    const Json& topC = sp.get("top"); Json empty = Json::object();
    const Json& topJ = topC.truth() ? topC : empty;
    auto M = std::make_shared<Model>();
    M->top = plateSet(topJ, piece, q, sp, 0, (pair ? 0.65 : 1) * kb, sr);
    M->modes = M->top.modes;
    if (pair) {
        const Json& botC = sp.get("bottom").truth() ? sp.get("bottom") : topJ;
        M->bot = plateSet(botC, piece, q, sp, 1, 0.55 * kb, sr); M->hasBot = true;
        M->modes.insert(M->modes.end(), M->bot.modes.begin(), M->bot.modes.end());
    }
    double g = M->top.A->E / (12 * M->top.A->rho * (1 - NU * NU));
    double cl = jmax(0, jmin(1, sp.orv("clamp", 0)));
    if (cl > 0) for (auto& md : M->modes) md.alpha += cl * cl * 16 * (0.45 + 0.55 * jmin(2.2, md.f / 2000)) + cl * 0.8;
    M->metal = true; M->cfg = cfg; M->piece = piece; M->pair = pair;
    M->dark = (piece == "crash" || piece == "splash") ? jmax(0, 0.7 - topJ.nn("lathe", 0.5)) * 0.6 : 0;
    M->a = M->top.a; M->nTop = (int) M->top.modes.size();
    M->B.modes.assign(M->modes.begin(), M->modes.begin() + M->nTop); M->B.sigma = M->top.A->rho * M->top.heff; M->B.a = M->top.a;
    M->SM = { M->top.A->name, 0, 0, std::round(1 / M->top.A->eta), 0 };
    M->gamma = g; M->bloom = sp.nn("bloom", 1); M->glide = piece == "opera" ? sp.nn("glide", 0.6) : 0;
    M->rivets = topC.truth() ? topC.orv("rivets", 0) : 0; M->chain = topC.truth() && topC.truthy("chain");
    M->hhClutch = sp.nn("clutch", 0.6); M->hhTilt = sp.nn("tilt", 0.3); M->hhGap = sp.nn("gap", 8); M->hhOpen = sp.nn("pedal", 0.15); M->hhPress = sp.nn("press", 0.5);
    M->mallet = malletOr(cfg); M->mix = cfg.get("mix").truth() ? cfg.get("mix") : Json::object(); M->mics = cfg.get("mics"); M->gain = 1;
    return M;
}

std::shared_ptr<Model> buildModel(const Json& cfgIn, double sr)
{
    const Json& spc = cfgIn.get("special");
    if (spc.truth() && spc.str("type") == "metal") return buildMetalModel(cfgIn, sr ? sr : 48000);
    Json cfg = cfgIn;
    const Json& sh = cfg.get("shell");
    const ShellMat* SMp = shellMat(sh.str("material")); ShellMat SM = SMp ? *SMp : *shellMat("maple");
    std::string kind = cfg.str("kind");
    bool two = kind == "double";
    double a = sh.num("diameter") * 0.0127, L = jmax(0.005, sh.num("depth") * 0.0254);
    auto M = std::make_shared<Model>();
    Json defMix = Json::object(); defMix.set("batter", Json::number(1)); defMix.set("reso", Json::number(0.6)); defMix.set("shell", Json::number(0.5));
    if (kind == "none") {
        M->cfg = cfg; M->two = false; M->none = true; M->a = a; M->aR = a; M->V = 1; M->Kc = 0;
        M->B.modes = bodyModes(cfg, SM); M->B.sigma = SM.rho * jmax(0.4, sh.orv("thickness", 3)) * 1e-3; M->B.a = a;
        M->SM = SM; M->snareOn = false; M->snareTension = 0.5; M->snareLevel = 0;
        M->mallet = malletOr(cfg); M->mix = cfg.get("mix").truth() ? cfg.get("mix") : defMix; M->gain = 1;
        return M;
    }
    double pillow = two ? cfg.orv("pillow", 0) : 0;
    bool barsB = spc.truth() && spc.str("type") == "bars", tongueDrum = spc.truth() && (spc.str("type") == "tongue" || barsB);
    if (tongueDrum) { cfg.set("kind", Json::string("single")); two = false; kind = "single"; }
    Json bat = cfg.get("batter");
    HeadMat shm; const HeadMat* matOv = nullptr;
    if (kind == "shellhead") { shm = shellHeadMat(SM); matOv = &shm; }
    if (cfg.truthy("lite")) bat.set("lite", Json::boolean(true));
    Head B = barsB ? barModel(cfg, SM, a) : tongueDrum ? tongueModel(cfg, SM, a) : headModes(bat, matOv, a, true, pillow, -1);
    double aR = a; Head R; bool hasR = false;
    auto edgeLoss = [&](Head& hd) { for (auto& md : hd.modes) md.alpha += (md.m == 0 ? 4 : 1.5) * SM.absorb + (md.f / 1000) * 6 / std::sqrt(SM.Q); };
    if (!tongueDrum) edgeLoss(B);
    const Json& reso = cfg.get("reso");
    if (two) { aR = (reso.truthy("diameter") ? reso.num("diameter") : sh.num("diameter")) * 0.0127; R = headModes(reso, nullptr, aR, false, pillow, 1); edgeLoss(R); hasR = true; }

    double V = 0; bool hasPort = false; Port port; std::vector<double> air; double rav = a, Lsh = L;
    std::string shape = sh.str("shape");
    if (two) {
        double bul = shape == "barrel" ? sh.orv("bulge", 0) : 0;
        rav = 0.5 * (a + aR) * (1 + 0.6 * bul);
        V = PI * rav * rav * L;
        if (reso.num("hole") > 0) { double rp = reso.num("hole") * 0.0127; hasPort = true; port.A = PI * rp * rp; port.L = 1.7 * rp + 0.002; port.Q = 6; }
        for (int n = 1; n <= 3; n++) air.push_back(n * C / (2 * L));
        air.push_back(1.841 * C / (TAU * rav));
    } else if (shape == "goblet" || shape == "kettle") {
        double bd = jmax(0.03, (sh.truthy("bowlDepth") ? sh.num("bowlDepth") : sh.num("depth")) * 0.0254);
        V = PI * a * a * bd * 0.62;
        double rp2 = jmax(0.2, sh.orv("portDiam", 4)) * 0.0127;
        double pl = shape == "goblet" ? sh.orv("portLen", 8) * 0.0254 : jmax(0.002, sh.orv("thickness", 2) * 1e-3);
        hasPort = true; port.A = PI * rp2 * rp2; port.L = pl + 1.7 * rp2; port.Q = 8;
        Lsh = bd + (shape == "goblet" ? pl : 0);
        if (shape == "goblet") { air.push_back(C / (2 * (pl + 1.2 * rp2))); air.push_back(C / (pl + 1.2 * rp2)); }
        air.push_back(1.841 * C / (TAU * a)); air.push_back(3.054 * C / (TAU * a));
    } else if (shape == "barrel") {
        double bulS = sh.orv("bulge", 0);
        double bd0 = sh.truthy("bottomDia") ? sh.num("bottomDia") : (kind == "single" ? (sh.truthy("portDiam") ? sh.num("portDiam") : sh.num("diameter") * 0.75) : sh.num("diameter"));
        double rB0 = bd0 * 0.0127;
        rav = 0.5 * (a + rB0) * (1 + 0.6 * bulS);
        if (kind == "shellhead") {
            V = PI * rav * rav * L * 0.95;
            double rv = jmax(0.005, sh.orv("portDiam", 3) * 0.0127);
            hasPort = true; port.A = PI * rv * rv; port.L = jmax(0.002, sh.orv("thickness", 6) * 1e-3) + 1.7 * rv; port.Q = 6;
            for (int n3 = 1; n3 <= 3; n3++) air.push_back(n3 * C / (2 * L));
            air.push_back(1.841 * C / (TAU * rav));
        } else {
            double rbot = jmax(0.01, jmin(rav * 1.2, rB0)), ellB = L + 0.6 * rbot;
            V = 0.81 * PI * rav * rav * ellB;
            hasPort = true; port.A = PI * rbot * rbot; port.L = ellB / 2; port.Q = 3;
            if (L > 0.08) for (int n4 = 1; n4 <= 3; n4++) air.push_back((2 * n4 - 1) * C / (4 * ellB) * (1 - 0.12 * bulS));
        }
    } else {
        double ell = L + 0.6 * a;
        V = 0.81 * PI * a * a * ell;
        hasPort = true; port.A = PI * a * a; port.L = ell / 2; port.Q = 3;
        if (L > 0.08) for (int n2 = 1; n2 <= 3; n2++) air.push_back((2 * n2 - 1) * C / (4 * ell));
    }
    if (hasPort) {
        port.mp = RHO * port.A * port.L;
        port.wH = std::sqrt(RHO * C * C * port.A / (V * port.L));
        port.alpha = port.wH / (2 * port.Q) + 10 * SM.absorb + pillow * 120;
    }
    double airQ = 4 + 26 * (1 - SM.absorb) * (1 - 0.8 * pillow);
    for (double f : air) if (f < 9000) { Res r; r.w = f * TAU; r.alpha = f * TAU / (2 * airQ); r.M = 0; r.rad = 1; M->airModes.push_back(r); }

    double hs = jmax(0.4, sh.orv("thickness", 6)) * 1e-3;
    double Ms = SM.rho * TAU * rav * hs * jmax(0.02, Lsh);
    M->shell = shellModes(SM, rav, jmax(0.02, Lsh), hs, Ms);
    std::string hk = sh.str("hoop");
    if (!tongueDrum && (two || shape == "cylinder" || shape == "open" || shape == "kettle" || shape == "barrel")) M->hoop = ringModes(hoopMat(hk), a + 0.006);
    if (!two && !tongueDrum && sh.truthy("hoop") && hk != "none") M->hoop = ringModes(hoopMat(hk), a + 0.006);

    const Json& sn = cfg.get("snare");
    M->cfg = cfg; M->two = two; M->a = a; M->aR = aR; M->V = V; M->Kc = RHO * C * C / V; M->hasPort = hasPort; M->port = port;
    M->tongue = tongueDrum; M->bars = barsB;
    if (tongueDrum) M->tongues = B.tongues;
    M->B = std::move(B); M->hasR = hasR; M->R = std::move(R); M->SM = SM;
    M->snareOn = sn.truthy("on") && !tongueDrum; M->snareTension = sn.nn("tension", 0.5); M->snareLevel = sn.nn("level", 0.7);
    M->mallet = malletOr(cfg); M->mics = cfg.get("mics");
    M->mix = cfg.get("mix").truth() ? cfg.get("mix") : defMix; M->gain = 1;
    return M;
}

void applyTrims(Model& model, const std::vector<double>* tr)
{
    if (!model.tongue || model.tongues.empty()) return;
    for (size_t i = 0; i < model.tongues.size(); i++) model.tongues[i].og = tr && i < tr->size() && (*tr)[i] > 0 ? (*tr)[i] : 1;
    for (auto& md : model.B.modes) {
        if (md.outW0 != md.outW0) md.outW0 = md.outW;
        double og = md.tg >= 0 && model.tongues[md.tg].og ? model.tongues[md.tg].og : 1;
        md.outW = md.outW0 * og;
    }
}
std::vector<double> trimsOf(const Model& model)
{
    std::vector<double> r; if (!model.tongue) return r;
    for (auto& t : model.tongues) r.push_back(t.og ? t.og : 1);
    return r;
}

} // namespace dh
