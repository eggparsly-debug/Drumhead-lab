// Player (rolls, brushes, bow, choke, pedal, output stage), Kit, and loudness calibration.
// Port of engine.js lines 1496-1842.
#include "dh_drum.h"
#include "dh_util.h"
#include <algorithm>
#include <cstdlib>

namespace dh {

// ---------------- Player ----------------
Player::Player(double sr_) : sr(sr_)
{
    auto hpq = [&](double q, double* o) {
        double w0 = TAU * 30 / sr, cw = std::cos(w0), al = std::sin(w0) / (2 * q), a0 = 1 + al;
        o[0] = (1 + cw) / 2 / a0; o[1] = -(1 + cw) / a0; o[2] = (1 + cw) / 2 / a0; o[3] = -2 * cw / a0; o[4] = (1 - al) / a0;
    };
    hpq(0.5412, hpA); hpq(1.3066, hpB);
    LA = (int) jmax(8, jsround(sr * 0.0015)); laL.assign(LA, 0); laR.assign(LA, 0); laG.assign(LA, 1);
    kAtk = 1 - std::exp(-4.0 / LA); kRel = 1 - std::exp(-1 / (0.09 * sr));
    tmpL.assign(128, 0); tmpR.assign(128, 0);
}

double Player::rand() { seed = lcg(seed); return seed / 4294967296.0; }
bool Player::isBrush() const { return model && model->mallet && model->mallet->brush; }
bool Player::isBow() const { return model && model->metal && model->mallet && model->mallet->bow; }

void Player::setModel(std::shared_ptr<Model> m)
{
    wake();
    bool wantMetal = m->metal;
    if (!core || core->isMetal() != wantMetal) core = wantMetal ? makeMetal(sr) : makeVoice(sr);
    core->setModel(m); model = m; gain = m->gain ? m->gain : 1;
    if (core->needSettle) { core->needSettle = false; core->settle(); }
    double tone = m->mix.nn("tone", 0.35);
    shelfG = std::pow(10.0, tone * 9 / 20) - 1; lowG = std::pow(10.0, jmax(0, tone) * 2 / 20) - 1;
    gT = 1 - std::exp(-TAU * 1200 / sr); gL = 1 - std::exp(-TAU * 90 / sr);
    double rs = m->cfg.orv("rollSpeed", 0); rollRate = rs ? rs : (rollRate ? rollRate : 14);
    if (pedalBase != pedalBase && m->metal && m->pair) pedalBase = m->hhOpen;
    if (m->metal && m->pair && !m->cfg.truthy("_keepPedal")) { pedalBase = m->hhOpen; if (!footDown) core->setPedal(pedalBase); }
}

void Player::strike(double r, double th, double vel, const std::string& mode)
{
    wake();
    if (!core) return;
    if (isBow()) { core->bowStart(r, th, vel); events.push_back({ t + jsround(0.6 * sr), 0, 0 }); return; }
    if (isBrush()) { brushHit(r, th, vel); return; }
    core->strike(r, th, vel, mode, nullptr);
}

const Tongue* Player::tongueOf(int i) const
{
    if (!model) return nullptr;
    for (auto& t : model->tongues) if (t.idx == i) return &t;
    return nullptr;
}

void Player::strikeTongue(int i, double vel)
{
    wake();
    if (core && core->hasTongues()) {
        if (isBrush()) { const Tongue* t = tongueOf(i); if (t) brushHit(t->rb - 0.82 * t->ln, t->th, vel); }
        else core->strikeTongue(i, vel);
    }
}

void Player::brushHit(double r, double th, double vel)
{
    wake();
    double a = model->a ? model->a : 0.17, spread = 0.045 / a; const int nb = 9;
    for (int b = 0; b < nb; b++) {
        double r1 = rand(); double rr = jmax(0, jmin(0.97, r + (r1 - 0.5) * spread * 2));
        double r2 = rand(); double tt = th + (r2 - 0.5) * spread * 2 / jmax(0.2, r);
        double r3 = rand(), r4 = rand(), r5 = rand();
        core->addPulse(rr, tt, 9 * vel * (0.4 + 0.6 * r3), 0.0005 + 0.0006 * r4, r5 * 0.007);
    }
    core->strike(r, th, vel * 0.5, "head", &BRUSH_MALLET);
    swish += 0.35 * vel;
}

void Player::noteOn(const std::string& id, const Stroke& st)
{
    wake();
    if (!core) return;
    if (isBow()) { core->bowStart(st.r, st.theta, st.vel); bowId = id; hasBowId = true; return; }
    if (model->cfg.truthy("roll")) {
        double ang = rand() * TAU;
        Roll R{ id, st, 0.4 * st.vel, st.vel, true, t, 0, ang };
        for (auto& x : rolls) if (x.id == id) { x = R; return; }
        rolls.push_back(R); return;
    }
    if (st.tongue >= 0) strikeTongue(st.tongue, st.vel); else strike(st.r, st.theta, st.vel, st.mode);
}

void Player::noteOff(const std::string& id)
{
    wake();
    rolls.erase(std::remove_if(rolls.begin(), rolls.end(), [&](const Roll& r) { return r.id == id; }), rolls.end());
    if (hasBowId && bowId == id && core && core->isMetal()) { core->bowStop(); hasBowId = false; }
}

void Player::pressure(const std::string* id, double v)
{
    wake();
    bool hit = false;
    Roll* Rp = nullptr; if (id) for (auto& x : rolls) if (x.id == *id) Rp = &x;
    if (Rp) { Rp->max = v; Rp->hasMax = true; if (Rp->lvl > v) Rp->lvl = v; hit = true; }
    else if (!id) for (auto& x : rolls) { x.lvl = v; hit = true; }
    if (hasBowId && core && core->isMetal()) { core->bowPressure(v); hit = true; }
    if (!hit && model && model->metal) core->setChoke(v);
}

void Player::choke(double v) { wake(); if (core) core->setChoke(v); }

void Player::cc(int num, double v)
{
    wake();
    if (num == 1) rollRate = 5 + v * 30;
    if (num == 4 && core && core->hasPedal()) { pedalBase = 1 - v; if (!footDown) core->setPedal(pedalBase); }
}

void Player::pedal(const std::string& kind)
{
    wake();
    if (!core || !core->hasPedal()) return;
    double base = pedalBase != pedalBase ? 0.2 : pedalBase;
    if (kind == "down") { footDown = true; core->setPedal(0); }
    else if (kind == "up") { footDown = false; core->setPedal(base); }
    else if (kind == "chick") { core->setPedal(0); events.push_back({ t + jsround(0.25 * sr), 1, base }); }
    else if (kind == "splash") core->pedalSplash(jmax(base, 0.8));
}

void Player::pedalValue(double open)
{
    wake();
    if (!core || !core->hasPedal()) return;
    pedalBase = open; if (!footDown) core->setPedal(open);
}

void Player::reset() { wake(); if (core) core->reset(); rolls.clear(); swish = 0; }

void Player::runRolls()
{
    for (auto& R : rolls) {
        if (t < R.next) continue;
        const Stroke& st = R.st; double rate = rollRate; R.hand = 1 - R.hand; int hand = R.hand;
        double vel = jmax(0.02, jmin(1, R.lvl * (hand ? 0.92 : 1) * (0.9 + 0.2 * rand())));
        if (R.hasMax) R.lvl += (R.max - R.lvl) * 0.2;
        double sr0 = st.r == st.r ? st.r : 0;
        if (isBrush()) {
            R.ang += 0.5; double rr = jmax(0.1, jmin(0.9, (sr0 ? sr0 : 0.4) * 0.6 + 0.25 * (1 + std::cos(R.ang)) * 0.5));
            core->addPulse(rr, R.ang, 3 * vel, 0.0008, 0); core->addPulse(rr, R.ang + 0.3, 2 * vel, 0.0008, 0.002);
            swish += 0.12 * vel; R.next = t + jsround(sr / 90);
            continue;
        }
        double ra = rand(); double jr = (ra - 0.5) * 0.04; double rb = rand(); double jt = (rb - 0.5) * 0.25;
        if (st.tongue >= 0) core->strikeTongue(st.tongue, vel);
        else core->strike(jmax(0, jmin(0.97, sr0 + jr)), st.theta + jt, vel, st.mode == "rimshot" ? std::string("head") : st.mode, nullptr);
        R.next = t + jsround(sr / rate * (0.92 + 0.16 * rand()));
    }
}

double Player::punchGain(double l, double r, double pu)
{
    if (!(pu > 0)) return 1;
    if (!pInit) { pInit = true; pA = 1; pR = 1 - std::exp(-1 / (0.1 * sr)); pE = 0; }
    double x = l < 0 ? -l : l, y = r < 0 ? -r : r; if (y > x) x = y;
    pE += (x > pE ? pA : pR) * (x - pE);
    double gc = pE > 0.126 ? std::pow(pE / 0.126, -0.8333) : 1;
    return 1 / (1 + 0.15 * pu) + pu * 1.6 * gc;
}

double Player::post(double y0, double* ts, double* dc)
{
    ts[0] += gT * (y0 - ts[0]); ts[1] += gL * (y0 - ts[1]);
    double y = y0 + shelfG * (y0 - ts[0]) + lowG * ts[1];
    const double* A = hpA; const double* B = hpB;
    double y1 = A[0] * y + A[1] * dc[0] + A[2] * dc[1] - A[3] * dc[2] - A[4] * dc[3]; dc[1] = dc[0]; dc[0] = y; dc[3] = dc[2]; dc[2] = y1;
    double yo = B[0] * y1 + B[1] * dc[4] + B[2] * dc[5] - B[3] * dc[6] - B[4] * dc[7]; dc[5] = dc[4]; dc[4] = y1; dc[7] = dc[6]; dc[6] = yo;
    yo *= gain;
    if (yo != yo || yo > 1e4 || yo < -1e4) { reset(); ts[0] = ts[1] = 0; for (int z = 0; z < 8; z++) dc[z] = 0; return 0; }
    return yo;
}

double Player::soft(double x)
{
    if (x > 0.97) return 0.97 + 0.03 * std::tanh((x - 0.97) / 0.03);
    if (x < -0.97) return -0.97 - 0.03 * std::tanh((-x - 0.97) / 0.03);
    return x;
}

void Player::process(float* outL, int n, float* outR)
{
    if (!core || asleep) { for (int z = 0; z < n; z++) { outL[z] = 0; if (outR) outR[z] = 0; } if (core) t += n; return; }
    int done = 0; const int BL = 32;
    while (done < n) {
        for (int e = (int) events.size() - 1; e >= 0; e--) if (events[e].at <= t) {
            Event ev = events[e]; events.erase(events.begin() + e);
            if (ev.kind == 0) core->bowStop();
            else if (ev.kind == 1) { if (!footDown) core->setPedal(ev.base); }
        }
        runRolls();
        int len = std::min(BL, n - done);
        float* L = tmpL.data(); float* R = tmpR.data();
        core->process(L, len, R);
        for (int i = 0; i < len; i++) {
            double sw = 0;
            if (swish > 1e-5 && !(model && model->cal)) {
                seed = lcg(seed); double wn = seed / 2147483648.0 - 1;
                sw1 += 0.26 * (wn - sw1); double hpn = wn - sw1; sw2 += 0.5 * (hpn - sw2); sw3 = sw3 + 0.5 * (sw2 - sw3);
                sw = sw3 * swish * 0.5 / (gain ? gain : 1); swish *= 0.9993;
            }
            if (inKit) {
                double xl = L[i] + sw, xr = R[i] + sw;
                tL[0] += gT * (xl - tL[0]); tL[1] += gL * (xl - tL[1]); tR[0] += gT * (xr - tR[0]); tR[1] += gL * (xr - tR[1]);
                double ol = (xl + shelfG * (xl - tL[0]) + lowG * tL[1]) * gain, or2 = (xr + shelfG * (xr - tR[0]) + lowG * tR[1]) * gain;
                if (ol != ol || or2 != or2) { reset(); ol = or2 = 0; }
                if (outR) { outL[done + i] = (float) ol; outR[done + i] = (float) or2; } else outL[done + i] = (float) (0.5 * (ol + or2));
                double qk = quietThr ? quietThr : 1.5e-5;
                if ((ol < 0 ? -ol : ol) > qk || (or2 < 0 ? -or2 : or2) > qk) quietN = 0; else quietN++;
                continue;
            }
            double l = post(L[i] + sw, tL, dcL), r = post(R[i] + sw, tR, dcR);
            if (punch > 0) { double pgn = punchGain(l, r, punch); l *= pgn; r *= pgn; }
            double al = l < 0 ? -l : l, ar = r < 0 ? -r : r, ap = al > ar ? al : ar, need = ap > CEIL ? CEIL / ap : 1;
            int li = laI; double dl = laL[li], dr = laR[li];
            if (laG[li] < 1) laN--; if (need < 1) laN++;
            laL[li] = (float) l; laR[li] = (float) r; laG[li] = (float) need; laI = li + 1 == LA ? 0 : li + 1;
            double gm = 1; if (laN > 0) { for (int q = 0; q < LA; q++) if (laG[q] < gm) gm = laG[q]; }
            if (gm < 1 || lg < 1) { lg += (gm < lg ? kAtk : kRel) * (gm - lg); if (lg > 0.99995) lg = 1; }
            l = soft(dl * lg); r = soft(dr * lg);
            if (outR) { outL[done + i] = (float) l; outR[done + i] = (float) r; } else outL[done + i] = (float) (0.5 * (l + r));
            double qt = quietThr ? quietThr : 1.5e-5;
            if ((l < 0 ? -l : l) > qt || (r < 0 ? -r : r) > qt) quietN = 0; else quietN++;
        }
        done += len; t += len;
        if (quietN > 0.3 * sr && events.empty() && !swish && rolls.empty() && core->mallets.empty() && core->pulses.empty() && !core->bowOn()) {
            asleep = true; for (int zz = done; zz < n; zz++) { outL[zz] = 0; if (outR) outR[zz] = 0; } t += n - done; return;
        }
    }
}

// ---------------- Kit ----------------
Kit::Kit(double sr_) : sr(sr_) { tLb.assign(128, 0); tRb.assign(128, 0); pieces.reserve(16); held.reserve(128); map.reserve(128); }

void Kit::preparePlayer(Player& p, std::shared_ptr<Model> m)
{
    p.quietThr = m->piece == "stack" ? 4e-4 : 1.2e-4; p.inKit = true;
    p.setModel(m); p.gain = m->gain ? m->gain : 1; if (p.core) p.core->kitMode = true;
}
std::unique_ptr<Player> Kit::swapPiece(int i, std::unique_ptr<Player> np, const double* level, const double* pan)
{
    if (i < 0) return np;
    if ((int) pieces.size() <= i) { if (i >= (int) pieces.capacity()) return np; pieces.resize(i + 1); }
    Piece& pc = pieces[i];
    auto old = std::move(pc.player);
    if (!old) { pc.level = 1; pc.pan = 0; pc.lp = 0; pc.drive = 0; }
    const Model& m = *np->model;
    pc.drum = !m.metal; pc.hat = m.metal && m.piece == "hihat"; pc.recv = m.snareOn ? 0.5 : 1;
    pc.player = std::move(np);
    if (level) pc.level = *level;
    if (pan) pc.pan = *pan;
    return old;
}
void Kit::trimInto(int n, std::vector<std::unique_ptr<Player>>& out)
{
    while ((int) pieces.size() > n) { if (out.size() < out.capacity()) out.push_back(std::move(pieces.back().player)); pieces.pop_back(); }
}

void Kit::setPiece(int i, std::shared_ptr<Model> m, const double* level, const double* pan)
{
    if ((int) pieces.size() <= i) pieces.resize(i + 1);
    Piece& pc = pieces[i];
    if (!pc.player) { pc.player = std::make_unique<Player>(sr); pc.level = 1; pc.pan = 0; pc.lp = 0; pc.drive = 0; }
    pc.player->quietThr = m->piece == "stack" ? 4e-4 : 1.2e-4; pc.player->inKit = true;
    pc.player->setModel(m); pc.player->gain = m->gain ? m->gain : 1; if (pc.player->core) pc.player->core->kitMode = true;
    if (level) pc.level = *level;
    if (pan) pc.pan = *pan;
    pc.drum = !m->metal; pc.hat = m->metal && m->piece == "hihat";
    pc.recv = m->snareOn ? 0.5 : 1;
}
void Kit::setMix(int i, const double* level, const double* pan)
{
    if (i < 0 || i >= (int) pieces.size()) return;
    if (level) pieces[i].level = *level;
    if (pan) pieces[i].pan = *pan;
}
void Kit::trim(int n) { if ((int) pieces.size() > n) pieces.resize(n); }
void Kit::setMap(const std::vector<std::pair<int, Slot>>& m) { map = m; }
const Slot* Kit::slotOf(int note) const
{
    for (auto& kv : map) if (kv.first == note) return (kv.second.p >= 0 && kv.second.p < (int) pieces.size() && pieces[kv.second.p].player) ? &kv.second : nullptr;
    return nullptr;
}
void Kit::noteOn(int note, double vel)
{
    const Slot* s = slotOf(note); if (!s) return; Player& P_ = *pieces[s->p].player;
    auto hold = [&]() { for (auto& kv : held) if (kv.first == note) { kv.second = *s; return; } held.emplace_back(note, *s); };
    if (!s->pedal.empty()) { P_.pedal(s->pedal); hold(); return; }
    if (s->open == s->open && pieces[s->p].hat) P_.pedalValue(s->open);
    Stroke st; st.r = s->r; st.theta = s->theta; st.vel = vel; st.mode = s->mode.empty() ? "head" : s->mode;
    double ov = pieces[s->p].rOv;
    if (ov == ov && (st.mode == "head" || st.mode == "shoulder")) st.r = ov;   // strike-position CC
    if (s->tongue >= 0) { st = Stroke(); st.tongue = s->tongue; st.vel = vel; }
    P_.noteOn("n" + std::to_string(note), st); hold();
}
void Kit::noteOff(int note)
{
    Slot s; bool found = false;
    for (size_t i = 0; i < held.size(); i++) if (held[i].first == note) { s = held[i].second; held.erase(held.begin() + i); found = true; break; }
    if (!found || s.p < 0 || s.p >= (int) pieces.size() || !pieces[s.p].player) return;
    Player& P_ = *pieces[s.p].player;
    if (s.pedal == "down") P_.pedal("up"); else P_.noteOff("n" + std::to_string(note));
}
void Kit::pressure(const int* note, double v)
{
    if (!note) { for (auto& pc : pieces) if (pc.player) pc.player->pressure(nullptr, v); return; }
    const Slot* s = slotOf(*note); if (s) { std::string id = "n" + std::to_string(*note); pieces[s->p].player->pressure(&id, v); }
}
void Kit::choke(int i, double v) { if (i >= 0 && i < (int) pieces.size() && pieces[i].player) pieces[i].player->choke(v); }
void Kit::cc(int num, double v) { for (auto& pc : pieces) if (pc.player && (num != 4 || pc.hat)) pc.player->cc(num, v); }
void Kit::reset() { for (auto& pc : pieces) if (pc.player) { pc.player->reset(); pc.lp = 0; pc.drive = 0; } held.clear(); }

void Kit::setStrikePos(int piece, double r) { if (piece >= 0 && piece < (int) pieces.size()) pieces[piece].rOv = r; }
void Kit::pedalPiece(int piece, double down) { if (piece >= 0 && piece < (int) pieces.size() && pieces[piece].player) pieces[piece].player->cc(4, down); }
void Kit::setPitch(int piece, double ratio) { if (piece >= 0 && piece < (int) pieces.size() && pieces[piece].player && pieces[piece].player->core) pieces[piece].player->core->setPitch(ratio); }

void Kit::process(float* L, int n, float* R, float* const* outL, float* const* outR, int nOut)
{
    for (int i = 0; i < nOut; i++) if (outL && outL[i]) for (int z = 0; z < n; z++) { outL[i][z] = 0; outR[i][z] = 0; }
    for (int z = 0; z < n; z++) { L[z] = 0; R[z] = 0; }
    int done = 0; const int BL = 64; int np = (int) pieces.size(); double g = 1 - std::exp(-TAU * 160 / sr);
    while (done < n) {
        int len = std::min(BL, n - done); float* tL = tLb.data(); float* tR = tRb.data();
        double tot = 0; for (int a = 0; a < np; a++) tot += pieces[a].drive;
        for (int i = 0; i < np; i++) {
            Piece& pc = pieces[i]; if (!pc.player) continue; Player& P_ = *pc.player;
            if (pc.drum && P_.core) {
                double ext = symp * 26 * pc.recv * (tot - pc.drive);
                P_.core->extP = ext;
                if ((ext > 0.15 || ext < -0.15) && P_.asleep) { P_.asleep = false; P_.quietN = 0; }
            }
            P_.process(tL, len, tR);
            double pn = jmax(-1, jmin(1, pc.pan)), gl = pc.level * std::cos((pn + 1) * PI / 4) * std::sqrt(2.0), gr = pc.level * std::sin((pn + 1) * PI / 4) * std::sqrt(2.0);
            double lp = pc.lp, acc = 0;
            float* dL = (outL && i < nOut && outL[i]) ? outL[i] : nullptr; float* dR = dL ? outR[i] : nullptr;
            if (dL) {   // own output: level, pan and the kit's output gain, no bus processing
                double og = out != out ? 0.75 : out;
                for (int k = 0; k < len; k++) {
                    double l = tL[k], r = tR[k]; dL[done + k] = (float) Player::soft(l * gl * og); dR[done + k] = (float) Player::soft(r * gr * og);
                    lp += g * (0.5 * (l + r) - lp); acc += lp;
                }
            } else
            for (int k = 0; k < len; k++) {
                double l = tL[k], r = tR[k]; L[done + k] = (float) (L[done + k] + l * gl); R[done + k] = (float) (R[done + k] + r * gr);
                lp += g * (0.5 * (l + r) - lp); acc += lp;
            }
            pc.lp = lp; pc.drive = pc.drum ? acc / len * pc.level : 0;
        }
        done += len;
    }
    if (!bus) {
        bus = std::make_unique<Player>(sr); bus->shelfG = 0; bus->lowG = 0;
        bus->gT = 1 - std::exp(-TAU * 1200 / sr); bus->gL = 1 - std::exp(-TAU * 90 / sr);
    }
    Player& B = *bus;
    B.gain = out != out ? 0.75 : out;
    for (int q = 0; q < n; q++) {
        double l = B.post(L[q], B.tL, B.dcL), r = B.post(R[q], B.tR, B.dcR);
        if (punch > 0) { double pgk = B.punchGain(l, r, punch); l *= pgk; r *= pgk; }
        double al = l < 0 ? -l : l, ar = r < 0 ? -r : r, ap = al > ar ? al : ar, need = ap > B.CEIL ? B.CEIL / ap : 1;
        int li = B.laI; double dl = B.laL[li], dr = B.laR[li];
        if (B.laG[li] < 1) B.laN--; if (need < 1) B.laN++;
        B.laL[li] = (float) l; B.laR[li] = (float) r; B.laG[li] = (float) need; B.laI = li + 1 == B.LA ? 0 : li + 1;
        double gm = 1; if (B.laN > 0) { for (int z2 = 0; z2 < B.LA; z2++) if (B.laG[z2] < gm) gm = B.laG[z2]; }
        if (gm < 1 || B.lg < 1) { B.lg += (gm < B.lg ? B.kAtk : B.kRel) * (gm - B.lg); if (B.lg > 0.99995) B.lg = 1; }
        L[q] = (float) Player::soft(dl * B.lg); R[q] = (float) Player::soft(dr * B.lg);
    }
}

std::vector<std::pair<int, Slot>> parseKitMap(const Json& map)
{
    std::vector<std::pair<int, Slot>> out;
    if (!map.isObj()) return out;
    for (auto& kv : map.o) {
        const Json& s = kv.second; if (!s.isObj()) continue;
        Slot sl; sl.p = (int) s.num("p");
        sl.r = s.get("r").isNullish() ? NAN : s.num("r");
        sl.theta = s.orv("theta", 0);
        sl.mode = s.str("mode");
        sl.tongue = s.get("tongue").isNullish() ? -1 : (int) s.num("tongue");
        sl.open = s.get("open").isNullish() ? NAN : s.num("open");
        sl.pedal = s.str("pedal");
        out.emplace_back(std::atoi(kv.first.c_str()), sl);
    }
    return out;
}

// ---------------- calibration ----------------
struct Hit { double r = 0.3, theta = 0, vel = 0.85; std::string mode = "head"; int tongue = -1; };

static std::vector<float> renderHit(std::shared_ptr<Model> model, double sr, const Hit& h, double seconds)
{
    Player vc(sr); vc.setModel(model); vc.gain = model->gain ? model->gain : 1;
    if (h.tongue >= 0) vc.strikeTongue(h.tongue, h.vel); else vc.strike(h.r, h.theta, h.vel, h.mode);
    int n = (int) jsround(seconds * sr); std::vector<float> out(n); const int blk = 512;
    for (int o = 0; o < n; o += blk) { int len = std::min(blk, n - o); vc.process(out.data() + o, len, nullptr); }
    return out;
}
static double peakOf(const std::vector<float>& x) { double p = 1e-12; for (float v : x) { double a = v < 0 ? -v : v; if (a > p) p = a; } return p; }
static double loudness(const std::vector<float>& x, double sr)
{
    double a = 0, b = 0, c = 0, g = 1 - std::exp(-TAU * 70 / sr), gs = 1 - std::exp(-TAU * 1500 / sr); int n = (int) x.size(); std::vector<double> y(n);
    for (int i = 0; i < n; i++) { a += g * (x[i] - a); double h1 = x[i] - a; b += g * (h1 - b); double h2 = h1 - b; c += gs * (h2 - c); double k = h2 + 0.58 * (h2 - c); y[i] = k * k; }
    int W = (int) jmin(n, jsround(0.4 * sr)), st = (int) jmax(1, jsround(0.025 * sr)); double best = 0;
    for (int s0 = 0; s0 + W <= n; s0 += st) { double q = 0; for (int j = s0; j < s0 + W; j++) q += y[j]; if (q > best) best = q; }
    return 10 * std::log10(best / W + 1e-30);
}
static double earTilt(double f)
{
    static const double T[][2] = { { 100, -8 }, { 200, -4.3 }, { 300, -2.6 }, { 500, -1 }, { 800, 0.6 }, { 1200, 1.6 }, { 2000, 2.8 }, { 4000, 4.2 }, { 8000, 5.5 } };
    const int n = 9;
    if (f <= T[0][0]) return T[0][1];
    for (int i = 1; i < n; i++) if (f <= T[i][0]) { double u = std::log(f / T[i - 1][0]) / std::log(T[i][0] / T[i - 1][0]); return T[i - 1][1] + u * (T[i][1] - T[i - 1][1]); }
    return T[n - 1][1];
}

double calibrate(Model& modelRef, double sr)
{
    // the model is shared with the throwaway players below
    std::shared_ptr<Model> model(&modelRef, [](Model*) {});
    const double LOUD_TARGET = -23;
    Json mixSave = model->mix;
    Json cm = Json::object(); cm.set("batter", Json::number(1)); cm.set("reso", Json::number(0.6)); cm.set("shell", Json::number(0.5));
    cm.set("tone", Json::number(mixSave.truth() && !mixSave.get("tone").isNullish() ? mixSave.num("tone") : 0.35));
    model->mix = cm; model->cal = true; model->gain = 1e-4;
    const Json& st = model->cfg.get("strike");
    bool hasR = st.truth() && !st.get("r").isNullish(); double rUser = hasR ? jmax(0.03, jmin(0.95, st.num("r"))) : 0;
    double thU = st.truth() && !st.get("theta").isNullish() ? st.num("theta") : 0.4;
    Hit calS; calS.r = hasR ? rUser : 0.3; calS.theta = thU;
    if (model->metal) calS.r = (model->piece == "bell" || model->piece == "cowbell") ? 0.9 : hasR ? rUser : 0.6;
    const Mallet* mlSave = model->mallet;
    if (mlSave && (mlSave->bow || mlSave->brush)) model->mallet = model->metal ? mallet("soft_mal") : mallet("stick");
    double tPk = 0;
    if (model->tongue) {
        std::vector<const Tongue*> ts; for (auto& t : model->tongues) ts.push_back(&t);
        std::stable_sort(ts.begin(), ts.end(), [](const Tongue* x, const Tongue* y) { return x->f < y->f; });
        calS = Hit(); calS.tongue = ts[ts.size() / 2]->idx;
        applyTrims(*model, nullptr);
        if (ts.size() > 2) {
            int nS = (int) std::min<size_t>(ts.size(), 10);
            struct Smp { double lf, L, pk, lk; };
            std::vector<Smp> smp;
            for (int si = 0; si < nS; si++) {
                const Tongue* tt = ts[(size_t) jsround(si * (ts.size() - 1.0) / (nS - 1))];
                Hit h; h.tongue = tt->idx; auto o2 = renderHit(model, sr, h, 0.35);
                smp.push_back({ std::log(tt->f), loudness(o2, sr) + earTilt(tt->f), peakOf(o2), 0 });
            }
            std::vector<double> Ls; for (auto& x : smp) Ls.push_back(x.L); std::sort(Ls.begin(), Ls.end()); double Lref = Ls[Ls.size() >> 1];
            std::vector<double> pks; for (auto& x : smp) pks.push_back(x.pk * std::pow(10.0, (Lref - x.L) / 20)); std::sort(pks.begin(), pks.end()); double pkRef = 1.25 * pks[pks.size() >> 1];
            for (auto& x : smp) { double k = std::pow(10.0, (Lref - x.L) / 20); if (x.pk * k > pkRef) k = pkRef / x.pk; x.lk = std::log(jmax(0.2, jmin(5, k))); }
            std::vector<Tongue*> mt; for (auto& t : model->tongues) mt.push_back(&t);
            for (Tongue* t : mt) {
                double lf = std::log(t->f); size_t j = 0; while (j < smp.size() - 2 && lf > smp[j + 1].lf) j++;
                const Smp& a0 = smp[j]; const Smp& a1 = smp[j + 1];
                double den = a1.lf - a0.lf; if (!den) den = 1;
                double u = jmax(0, jmin(1, (lf - a0.lf) / den));
                t->og = std::exp(a0.lk + u * (a1.lk - a0.lk));
            }
            std::vector<double> tr; for (auto& t : model->tongues) tr.push_back(t.og);
            applyTrims(*model, &tr);
            tPk = 0; for (auto& x : smp) tPk = jmax(tPk, x.pk * std::exp(x.lk));
        }
    }
    auto out = renderHit(model, sr, calS, 0.5);
    double pk = jmax(peakOf(out), 0.85 * tPk), loud = loudness(out, sr);
    if (model->piece == "hihat") {
        Player vh(sr); vh.setModel(model); vh.gain = model->gain; if (vh.core->hasPedal()) vh.core->setPedal(0.85);
        std::vector<float> bh((size_t) jsround(0.25 * sr)), th0((size_t) jsround(0.3 * sr));
        vh.process(th0.data(), (int) th0.size(), nullptr);
        vh.strike(calS.r, calS.theta, 0.85, "head"); vh.process(bh.data(), (int) bh.size(), nullptr); pk = jmax(pk, 0.62 * peakOf(bh));
    }
    if (model->metal && model->piece != "bell" && model->piece != "cowbell") {
        Hit a; a.r = 0.6; a.theta = thU; Hit b; b.r = 0.6; b.theta = 0.4; Hit c; c.r = 0.08; c.theta = 0.4;
        double pa = 0.85 * peakOf(renderHit(model, sr, a, 0.35)), pb = 0.85 * peakOf(renderHit(model, sr, b, 0.35)), pc = 0.45 * peakOf(renderHit(model, sr, c, 0.35));
        pk = jmax(pk, jmax(pa, jmax(pb, pc)));
    } else if (!model->metal && !model->tongue) {
        Hit a; a.r = 0.06; a.theta = 0.4; Hit b; b.r = 0.5; b.theta = 0.4;
        double pa = 0.6 * peakOf(renderHit(model, sr, a, 0.25)), pb = 0.6 * peakOf(renderHit(model, sr, b, 0.25));
        pk = jmax(pk, jmax(pa, pb));
    }
    if (mlSave && mlSave->brush) {
        model->mallet = mlSave; auto bo = renderHit(model, sr, calS, 0.5); loud = loudness(bo, sr) + 5; pk = 1.2 * peakOf(bo);
    }
    model->mix = mixSave; model->mallet = mlSave;
    double gPeak = (model->metal ? 0.42 : 0.5) * 1e-4 / pk, gLoud = 1e-4 * std::pow(10.0, (LOUD_TARGET - loud) / 20);
    model->gain = jmin(gPeak, gLoud); model->cal = false;
    return model->gain;
}

} // namespace dh
