// Real-time drum voice: port of engine.js Voice (membranes + air cavity + snare wires + shell + hoop).
#include "dh_drum.h"
#include "dh_internal.h"
#include "dh_util.h"
#include <algorithm>
#include <cstring>

namespace dh {

MicW micWeights(const std::vector<const Mode*>& modes, const std::function<double(const Mode&, double, double)>& shapeFn, const Json& mics, const std::vector<double>* outWs)
{
    MicW r; size_t n = modes.size(); r.L.assign(n, 0); r.R.assign(n, 0);
    double width = mics.nn("width", 0.7), height = mics.nn("height", 0.8), pan = mics.orv("pan", 0);
    double nf = jmin(0.95, width / (1 + 0.8 * height * height));
    double thL = 2.25 + pan * 0.9, thR = 0.55 + pan * 0.9, rm = 0.65;
    for (size_t i = 0; i < n; i++) {
        const Mode& md = *modes[i]; double w = outWs ? (*outWs)[i] : md.outW;
        double sl = shapeFn(md, rm, thL), sr = shapeFn(md, rm, thR);
        double ohW = w / (1 + 0.6 * height);
        double common = (1 - nf) * (md.m <= 1 || md.m == 99 ? 1 : 0.45);
        r.L[i] = ohW * (common + nf * 1.5 * sl);
        r.R[i] = ohW * (common + nf * 1.5 * sr);
    }
    double a = (pan + 1) * PI / 4, close = mics.nn("close", 1), oh = mics.nn("oh", 0.7);
    r.cL = close * std::cos(a) * std::sqrt(2.0) * 0.5; r.cR = close * std::sin(a) * std::sqrt(2.0) * 0.5; r.oh = oh * 0.8;
    return r;
}

namespace {

struct Bank {
    int n = 0; std::vector<double> rad, w2, a2, invM, y, v;
    void build(const std::vector<Res>& arr, double d) {
        n = (int) arr.size(); rad.assign(n, 1); w2.assign(n, 0); a2.assign(n, 0); invM.assign(n, 1); y.assign(n, 0); v.assign(n, 0);
        for (int i = 0; i < n; i++) {
            const Res& r = arr[i]; double wd = r.w * d < 1.9 ? 2 / d * std::sin(r.w * d / 2) : 0;
            w2[i] = wd * wd; a2[i] = 2 * r.alpha; rad[i] = r.rad; invM[i] = r.M ? 1 / r.M : 1;
        }
    }
};
struct Wire { double y = 0, v = 0, Fp = 0, mf = 1; };

class Voice : public Core {
public:
    explicit Voice(double sr_) : sr(sr_) {}
    bool isMetal() const override { return false; }
    bool hasTongues() const override { return true; }

    void setModel(std::shared_ptr<Model> m) override
    {
        bool hadQ = haveQ; int prevN = nModes;
        model = m; const Model& md0 = *m;
        std::vector<const Mode*> list; std::vector<int> head;
        for (auto& x : md0.B.modes) { list.push_back(&x); head.push_back(0); }
        if (md0.hasR) for (auto& x : md0.R.modes) { list.push_back(&x); head.push_back(1); }
        int N = (int) list.size(); nModes = N; nB = (int) md0.B.modes.size();
        double Yc = 0;
        for (auto* it : list) if (it->S) Yc += it->S * it->S / it->M;
        if (md0.hasPort) Yc += md0.port.A * md0.port.A / md0.port.mp;
        Ycav = Yc;
        double wmax = 2 * PI * 1500;
        int os_ = (int) jmin(6, jmax(1, std::ceil(wmax / sr / 0.45)));
        if (md0.snareOn && !md0.tongue) {
            int snH = md0.two ? 1 : 0; double Yest = 0;
            for (int i = 0; i < N; i++) if (head[i] == snH && list[i]->m == 0) Yest += 1 / list[i]->M;
            double dt1 = 1 / sr, X1 = 0.004 * std::pow(TAU * 2600, 2) * dt1 * dt1 * (Yest * 3 * jmax(0.05, md0.snareLevel) + 1 / 0.0032);
            os_ = (int) jmin(6, jmax(os_, std::ceil(std::sqrt(X1 / 14))));
        }
        os = os_; dt = 1 / (sr * os);
        auto A = [&](std::vector<double>& v) { v.assign(N, 0); };
        A(w2); A(a2); A(invM); A(S); A(rimF); A(tmw); A(frac); A(oB); A(oR); A(cSn);
        int snHead = md0.two ? 1 : 0;
        for (int i = 0; i < N; i++) {
            const Mode& md = *list[i]; int hd = head[i];
            double wd = md.w * dt < 1.9 ? 2 / dt * std::sin(md.w * dt / 2) : 0;
            w2[i] = wd * wd; a2[i] = wd ? 2 * md.alpha : 0;
            invM[i] = wd ? 1 / md.M : 0; S[i] = md.S; rimF[i] = md.rimF;
            tmw[i] = (hd == 0 && md.f < 2500) ? md.tmw : 0; frac[i] = md.w * dt < 1.4 ? md.frac : 0;
            oB[i] = hd == 0 ? md.outW : 0; oR[i] = hd == 1 ? md.outW : 0;
            cSn[i] = (md0.snareOn && hd == snHead && md.m == 0) ? 1 : 0;
        }
        A(chW); for (int i = 0; i < N; i++) chW[i] = 60 + 0.004 * list[i]->w;
        zIdx.clear(); tIdx.clear();
        for (int i = 0; i < N; i++) { if (S[i] || rimF[i] || cSn[i]) zIdx.push_back(i); if (tmw[i]) tIdx.push_back(i); }
        std::vector<double> outWs(N); for (int i = 0; i < N; i++) outWs[i] = head[i] == 0 ? list[i]->outW : list[i]->outW * 0.6;
        const Model* mp = m.get();
        MicW mw = micWeights(list, [mp](const Mode& md, double r, double th) { return modeShape(*mp, md, r, th); }, md0.mics, &outWs);
        oHL = mw.L; oHR = mw.R; mcL = mw.cL; mcR = mw.cR; moh = mw.oh;
        double bend = md0.cfg.get("bend").isNullish() ? 1 : md0.cfg.num("bend");
        tmCoef = md0.B.tmCoef * 0.08 * bend;
        sgnSn = md0.two ? -1 : 1;
        bool keep = hadQ && prevN == N;
        if (!keep) { q.assign(N, 0); v.assign(N, 0); mallets.clear(); }
        haveQ = true;
        shellB.build(md0.shell, dt); hoopB.build(md0.hoop, dt); airB.build(md0.airModes, dt);
        if (!keep) { px = 0; pv = 0; pPrev = 0; haveWires = false; }
        double t = md0.snareTension, fw = 35 + 140 * t, mw0 = 0.004;
        double snT0 = md0.cfg.str("kind") == "shellhead" ? 3000 : (md0.two ? md0.R.T : md0.B.T);
        double snT = snT0 ? snT0 : 3000;
        envK = 0.02 * jmin(6, jmax(1, 3000 / snT));
        Wm = mw0; Wk = mw0 * std::pow(TAU * fw, 2); Wgap = (0.04 + 0.22 * t) * 1e-3; Wkc = mw0 * std::pow(TAU * 2600, 2); Walpha = 25 + 20 * t;
        if (!haveWires) { wires[0] = { 0, 0, 0, 1 }; wires[1] = { 0, 0, 0, 0.8 }; wires[2] = { 0, 0, 0, 1.25 }; haveWires = true; needSettle = md0.snareOn; }
        vol = volv = tm = rim = qc = qcv = 0;
        double ys = 0; for (int i = 0; i < N; i++) ys += cSn[i] * invM[i]; Ysn = ys;
        double yW = Ysn * 3 * jmax(0.05, md0.snareLevel) + 1 / (Wm * 0.8);
        WkcE = jmin(Wkc, 14 / (dt * dt * yW));
        mixB = md0.mix.num("batter"); mixR = md0.mix.num("reso"); mixS = md0.mix.num("shell");
        gClk = 1 - std::exp(-TAU * 5500 / sr);
        w2b = w2; double p0 = pitch; pitch = 1; setPitch(p0);
    }

    void setPitch(double ratio) override
    {
        if (ratio == pitch) return;
        pitch = ratio; double r2 = ratio * ratio, lim = (1.95 / dt) * (1.95 / dt);
        for (size_t i = 0; i < w2.size() && i < w2b.size(); i++) w2[i] = std::min(w2b[i] * r2, lim);
    }

    void strike(double r, double theta, double vel, const std::string& mode, const Mallet*) override
    {
        sinceHit = 0;
        if (!model) return;
        const Mallet& ml = *model->mallet;
        double v0 = ml.vmax * std::pow(jmax(0.01, jmin(1, vel)), 1.3);
        auto mk = makePsi(jmin(0.98, r), theta, ml.rc);
        auto pulse = [&](double dur, double amp, double hoop, std::shared_ptr<std::vector<double>> psi, double hd) {
            Pulse P{ 0, dur, amp, hoop, hd, psi.get(), psi }; pulses.push_back(P);
        };
        if (mode == "rim") {
            auto pr = std::make_shared<std::vector<double>>(makePsi(0.97, theta, 0.01)); double dR = jmax(0.0002, ml.tau * 0.5);
            pulse(dR, 0.52 * jmin(ml.mass, 0.06) * v0 * 1.6 * PI / (2 * dR), 1, nullptr, 0);
            pulse(0.0006, 0.3 * jmin(ml.mass, 0.06) * v0 * 1.6 * PI / (2 * 0.0006), 0, pr, 0.006);
            return;
        }
        if (mode == "rimclick") {
            auto ps = std::make_shared<std::vector<double>>(makePsi(0.9, theta, 0.01));
            pulse(0.00025, 0.4 * jmin(ml.mass, 0.06) * v0 * 1.6 * PI / (2 * 0.00025), 1, nullptr, 0);
            pulse(0.0008, 0.4 * jmin(ml.mass, 0.06) * v0 * 1.6 * PI / (2 * 0.0008), 0, ps, 0.012);
            return;
        }
        double klin = ml.mass * std::pow(PI / ml.tau, 2), d0 = 3 * ml.tau / PI;
        double kc = klin * std::pow(d0, 1 - ml.alpha);
        double h = 0, hv = 0; for (int i = 0; i < nB; i++) { h += mk[i] * q[i]; hv += mk[i] * v[i]; }
        if (mallets.size() > 1) mallets.erase(mallets.begin());
        double Y = 0; for (int i = 0; i < nB; i++) Y += mk[i] * mk[i] * invM[i];
        ringSet(ml);
        Contact c; c.Y = Y; c.psi = std::move(mk); c.y = h; c.v = v0; c.v0 = v0; c.m = ml.mass; c.kc = kc; c.al = ml.alpha; c.loss = jmin(0.85, 2 * ml.lam); c.h = h; c.hv = hv;
        mallets.push_back(std::move(c));
        if (mode == "rimshot") {
            double dur = jmax(0.00015, ml.tau * 0.5);
            pulse(dur, 0.6 * jmin(ml.mass, 0.06) * v0 * 1.6 * PI / (2 * dur), 1, nullptr, 0);
        }
    }

    void strikeTongue(int i, double vel) override
    {
        if (!model) return; const Tongue* t = nullptr;
        for (auto& x : model->tongues) if (x.idx == i) { t = &x; break; }
        if (!t) return;
        if (t->bar) strike(t->rb - 0.33 * t->ln, t->th + 0.22 * t->hw, vel, "head", nullptr);
        else strike(t->rb - 0.82 * t->ln, t->th + 0.15 * t->hw, vel, "head", nullptr);
    }

    void settle() override
    {
        int n = (int) jsround(0.25 * sr); float buf[256], bR[256]; double c0 = chk, ct = chkT;
        chk = chkT = 1;
        for (int o = 0; o < n; o += 256) process(buf, 256, bR);
        chk = c0; chkT = ct; env = 0; bzA = bzB = 0; clp = 0; Fprev = 0;
        for (int i = 0; i < nModes; i++) v[i] = 0;
    }

    void addPulse(double r, double th, double amp, double dur, double delay) override
    {
        if (!model) return; auto ps = std::make_shared<std::vector<double>>(makePsi(jmin(0.98, r), th, 0.006));
        pulses.push_back(Pulse{ -delay, dur, amp, 0, 1, ps.get(), ps });
    }

    void reset() override
    {
        bzA = bzB = 0; env = 0;
        if (!haveQ) return;
        std::fill(q.begin(), q.end(), 0.0); std::fill(v.begin(), v.end(), 0.0); mallets.clear(); pulses.clear();
        for (Bank* b : { &shellB, &hoopB, &airB }) { std::fill(b->y.begin(), b->y.end(), 0.0); std::fill(b->v.begin(), b->v.end(), 0.0); }
        px = pv = pPrev = 0; env = 0; chk = 0; chkT = 0; svf1 = svf2 = 0; Fprev = 0; clp = 0;
        if (rbOn0) { std::fill(rby1.begin(), rby1.end(), 0.0); std::fill(rby2.begin(), rby2.end(), 0.0); }
        for (auto& w : wires) { w.y = 0; w.v = 0; w.Fp = 0; }
    }

    void process(float* out, int n, float* outRt) override
    {
        sinceHit += n;
        bool sympOnly = kitMode && sinceHit > 1.5 * sr && mallets.empty() && pulses.empty();
        if (sympOnly && !wasSymp) {
            std::vector<uint8_t> inZ(nModes, 0); for (int z : zIdx) inZ[z] = 1;
            for (int zq = 0; zq < nModes; zq++) if (!inZ[zq]) { q[zq] = 0; v[zq] = 0; }
        }
        wasSymp = sympOnly;
        const int* sIdx = sympOnly ? zIdx.data() : nullptr; int NN = sympOnly ? (int) zIdx.size() : nModes;
        if (!model) { for (int z = 0; z < n; z++) { out[z] = 0; if (outRt) outRt[z] = 0; } return; }
        const Model& md = *model;
        int N = nModes; double Kc = md.Kc; const Port* port = md.hasPort ? &md.port : nullptr;
        bool snOn = md.snareOn; double snLvl = md.snareLevel, sgn = sgnSn;
        const double cS = 1, cH = 0.08;
        double fsv = 2 * std::sin(PI * jmin(0.24, 4200 / sr)), qsv = 1.1;
        std::vector<double>& plF = plFv; std::vector<const double*>& plP = plPv;
        for (int s = 0; s < n; s++) {
            double outB = 0, outR = 0, outS = 0, outH = 0, outP = 0, outA = 0, buzz = 0, Fsum = 0;
            for (int sub = 0; sub < os; sub++) {
                double Fhoop = 0; int npl = 0;
                if (plF.size() < pulses.size()) { plF.resize(pulses.size()); plP.resize(pulses.size()); }
                for (int pi = (int) pulses.size() - 1; pi >= 0; pi--) {
                    Pulse& P = pulses[pi]; P.t += dt;
                    if (P.t < 0) continue;
                    if (P.t >= P.dur) { pulses.erase(pulses.begin() + pi); continue; }
                    double fp = P.amp * std::sin(PI * P.t / P.dur);
                    Fhoop += fp * P.hoop; if (P.psi) { plF[npl] = fp * P.head; plP[npl] = P.psi->data(); npl++; }
                }
                chk = chk + (chkT - chk) * 0.002;
                double ch = chk;
                double volP = vol + volv * dt - (port ? port->A * (px + pv * dt) : 0);
                double p = Kc * volP / (1 + Kc * dt * dt * Ycav);
                double Fsn = 0;
                if (snOn) {
                    double u = sgn * (qc + qcv * dt), Ys = Ysn * 3 * snLvl;
                    for (int wi = 0; wi < 3; wi++) {
                        Wire& Wr = wires[wi]; double dl = u - (Wr.y + Wr.v * dt), Fc = 0;
                        if (dl > 0) Fc = WkcE * dl / (1 + WkcE * dt * dt * (Ys + 1 / (Wm * Wr.mf)));
                        double acc = (Fc - Wk * Wr.mf * (Wr.y + Wgap)) / (Wm * Wr.mf) - Walpha * Wr.v;
                        Wr.v += acc * dt; Wr.y += Wr.v * dt;
                        double dF = Fc - Wr.Fp; Wr.Fp = Fc;
                        env += (dF < 0 ? -dF : dF) * envK;
                        Fsn += Fc;
                    }
                    Fsn = -sgn * Fsn * snLvl;
                }
                double modr = tmCoef * tm, mod = modr > 0 ? 0.6 * std::tanh(modr / 0.6) : 0;
                int nm = (int) mallets.size();
                Contact* m0 = nm > 0 ? &mallets[0] : nullptr; Contact* m1 = nm > 1 ? &mallets[1] : nullptr;
                const double* ps0 = m0 ? m0->psi.data() : nullptr; const double* ps1 = m1 ? m1->psi.data() : nullptr;
                double h0 = 0, h1 = 0;
                for (int ii = 0; ii < NN; ii++) {
                    int i = sIdx ? sIdx[ii] : ii;
                    double f = -(p + extP) * S[i] + Fsn * cSn[i];
                    for (int pk = 0; pk < npl; pk++) f += plF[pk] * plP[pk][i];
                    double qi = q[i];
                    double ac = f * invM[i] - w2[i] * (1 + mod * frac[i]) * qi - (a2[i] + ch * chW[i]) * v[i];
                    double vi = v[i] + ac * dt; qi += vi * dt; v[i] = vi; q[i] = qi;
                    if (ps0) h0 += ps0[i] * qi;
                    if (ps1) h1 += ps1[i] * qi;
                }
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
                double vl = 0, vlv = 0, tmv = 0, rm = 0, qcs = 0, qcvs = 0, ob = 0, orr = 0, hv0 = 0, hv1 = 0, ohl_ = 0, ohr_ = 0;
                for (int jj = 0; jj < NN; jj++) {
                    int i2 = sIdx ? sIdx[jj] : jj; double vi2 = v[i2], qi2 = q[i2];
                    if (F0 || F1) {
                        double dv = (F0 * (ps0 ? ps0[i2] : 0) + F1 * (ps1 ? ps1[i2] : 0)) * invM[i2];
                        vi2 += dv; qi2 += dv * dt; v[i2] = vi2; q[i2] = qi2;
                    }
                    if (i2 < nB) ob += oB[i2] * vi2; else orr += oR[i2] * vi2;
                    ohl_ += oHL[i2] * vi2; ohr_ += oHR[i2] * vi2;
                    if (ps0) hv0 += ps0[i2] * vi2;
                    if (ps1) hv1 += ps1[i2] * vi2;
                }
                for (int iz : zIdx) { double qz = q[iz], vz = v[iz]; vl += S[iz] * qz; vlv += S[iz] * vz; rm += rimF[iz] * qz; qcs += cSn[iz] * qz; qcvs += cSn[iz] * vz; }
                for (int it2 : tIdx) { double qt = q[it2]; tmv += tmw[it2] * qt * qt; }
                if (m0) m0->hv = hv0;
                if (m1) m1->hv = hv1;
                Fsum = (F0 + F1) / dt;
                vol = vl; volv = vlv; tm = tmv; rim = rm; qc = qcs; qcv = qcvs;
                for (int k3 = (int) mallets.size() - 1; k3 >= 0; k3--) { Contact& Mr = mallets[k3]; if (Mr.gone || Mr.life > 0.05) mallets.erase(mallets.begin() + k3); }
                if (port) { pv += (p * port->A / port->mp - 2 * port->alpha * pv) * dt; px += pv * dt; }
                double dp = (p - pPrev) / dt; pPrev = p;
                double oa = 0;
                for (int ai = 0; ai < airB.n; ai++) {
                    double av = airB.v[ai] + (dp * 1e-4 - airB.w2[ai] * airB.y[ai] - airB.a2[ai] * airB.v[ai]) * dt;
                    airB.v[ai] = av; airB.y[ai] += av * dt; oa += av;
                }
                double os_ = 0, oh = 0;
                for (int si = 0; si < shellB.n; si++) {
                    double sv = shellB.v[si] + ((rim * cS + Fhoop * 0.3) * shellB.invM[si] - shellB.w2[si] * shellB.y[si] - shellB.a2[si] * shellB.v[si]) * dt;
                    shellB.v[si] = sv; shellB.y[si] += sv * dt; os_ += sv * shellB.rad[si];
                }
                for (int hi = 0; hi < hoopB.n; hi++) {
                    double hv2 = hoopB.v[hi] + ((rim * cH + Fhoop) * hoopB.invM[hi] - hoopB.w2[hi] * hoopB.y[hi] - hoopB.a2[hi] * hoopB.v[hi]) * dt;
                    hoopB.v[hi] = hv2; hoopB.y[hi] += hv2 * dt; oh += hv2 * hoopB.rad[hi];
                }
                if (sub == os - 1) { outB = ob; outR = orr; ohl = ohl_; ohr = ohr_; outS = os_; outH = oh; outP = port ? pv * port->A / (PI * md.a * md.a) : 0; outA = oa; }
            }
            double dF = Fsum - Fprev; Fprev = Fsum;
            double click = dF * resK * RESK;
            if (rbOn0 && (dF != 0 || rbOn)) {
                rbOn = false;
                for (int ri = 0; ri < rbN; ri++) {
                    double yr = rbc1[ri] * rby1[ri] + rbc2[ri] * rby2[ri] + rbg[ri] * dF; rby2[ri] = rby1[ri]; rby1[ri] = yr; click += yr * resK * RINGK;
                    if (yr > 1e-9 || yr < -1e-9) rbOn = true;
                }
            }
            clp = clp + gClk * (click - clp); click = clp;
            if (snOn) {
                noise = xorshift(noise);
                double wn = (double) noise / 2147483648.0;
                double lp = svf2 + fsv * svf1, hp = wn - lp - qsv * svf1, bp = fsv * hp + svf1;
                svf1 = bp; svf2 = lp;
                env *= 0.995; if (env > 50) env = 50;
                double eD = env / (env + 0.008), cB = 0.2 + 0.45 * eD;
                double bz = bp + 0.15 * hp; bzA = bzA + cB * (bz - bzA); bzB = bzB + cB * (bzA - bzB);
                buzz = 2.9 * env * bzB * snLvl;
            }
            double micB = outB + 0.12 * outS + 0.25 * outH + 0.5 * buzz + 0.1 * outA + click;
            double micR = outR + 0.6 * outP + buzz + 0.25 * outS + 0.3 * outA + 0.3 * click;
            double y0 = mixB * micB + mixR * micR + mixS * (outS * 0.5 + outH * 0.6);
            double ext = 0.35 * mixS * (outS * 0.5 + outH * 0.6) + 0.5 * buzz + 0.4 * click + 0.3 * outP + 0.1 * outA;
            double yl = mcL * y0 + moh * (ohl + ext), yr = mcR * y0 + moh * (ohr + ext);
            if (yl != yl || yr != yr || yl > 1e6 || yl < -1e6) { reset(); yl = yr = 0; }
            out[s] = (float) yl; if (outRt) outRt[s] = (float) yr;
            if ((s & 255) == 255 && mallets.empty() && pulses.empty()) {
                double qm = 0; for (int zz = 0; zz < N; zz++) { double av2 = v[zz] < 0 ? -v[zz] : v[zz]; if (av2 > qm) qm = av2; }
                if (qm < 1e-14) reset();
            }
        }
    }

private:
    std::vector<double> makePsi(double r, double theta, double rc) const
    {
        const auto& Bm = model->B.modes; std::vector<double> out(nModes, 0.0);
        for (size_t i = 0; i < Bm.size(); i++) out[i] = modeShape(*model, Bm[i], r, theta) * std::exp(-std::pow(Bm[i].k * rc, 2) / 8);
        return out;
    }
    void ringSet(const Mallet& ml)
    {
        if (!rbOn0 || rbFor != &ml) {
            rbFor = &ml; rbOn0 = true; rbN = (int) ml.ring.size(); rbOn = false;
            rbc1.clear(); rbc2.clear(); rbg.clear(); rby1.assign(rbN, 0); rby2.assign(rbN, 0);
            for (int i = 0; i < rbN; i++) {
                double w = TAU * ml.ring[i][0] / sr, rr = std::exp(-w / (2 * ml.ring[i][1]));
                rbc1.push_back(2 * rr * std::cos(w)); rbc2.push_back(-rr * rr); rbg.push_back(ml.ring[i][2] * (1 - rr));
            }
        }
        double clk = 1;
        if (model && model->bars) { clk = (!model->tongues.empty() && model->tongues[0].clk) ? model->tongues[0].clk : 0.08; }
        resK = ml.click / (ml.mass * 2e4) * clk;
    }

    double sr; int nModes = 0, nB = 0, os = 1; double dt = 0; bool haveQ = false;
    std::vector<double> w2b;
    std::vector<double> q, v, w2, a2, invM, S, rimF, tmw, frac, oB, oR, cSn, chW, oHL, oHR;
    std::vector<int> zIdx, tIdx;
    double Ycav = 0, tmCoef = 0, sgnSn = 1, mcL = 0, mcR = 0, moh = 0;
    Bank shellB, hoopB, airB;
    double px = 0, pv = 0, pPrev = 0;
    bool haveWires = false; Wire wires[3];
    double Wm = 0.004, Wk = 0, Wgap = 0, Wkc = 0, Walpha = 0, WkcE = 0, envK = 0, Ysn = 0;
    double vol = 0, volv = 0, tm = 0, rim = 0, qc = 0, qcv = 0, ohl = 0, ohr = 0;
    double mixB = 1, mixR = 0.6, mixS = 0.5, gClk = 0;
    double env = 0, bzA = 0, bzB = 0, svf1 = 0, svf2 = 0, clp = 0, Fprev = 0, resK = 0;
    int32_t noise = 22222;
    bool wasSymp = false;
    const Mallet* rbFor = nullptr; bool rbOn0 = false, rbOn = false; int rbN = 0;
    std::vector<double> rbc1, rbc2, rbg, rby1, rby2;
    std::vector<double> plFv; std::vector<const double*> plPv;
};

} // namespace

std::unique_ptr<Core> makeVoice(double sr) { return std::make_unique<Voice>(sr); }

} // namespace dh
