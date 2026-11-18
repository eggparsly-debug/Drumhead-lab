#include "dh_host.h"
#include "dh_util.h"
#include <algorithm>

namespace dh {

static Stroke strokeOf(const Json& s)
{
    Stroke st;
    st.r = s.get("r").isNullish() ? NAN : s.num("r");
    st.theta = s.orv("theta", 0);
    st.vel = s.num("vel");
    st.mode = s.truthy("mode") ? s.str("mode") : "head";
    st.tongue = s.get("tongue").isNullish() ? -1 : (int) s.num("tongue");
    return st;
}
MidiMap parseMidiMap(const Json& j)
{
    MidiMap m;
    if (!j.isObj()) { m.nCc = 2; m.ccs[0].cc = 4; m.ccs[1].cc = 1; return m; }
    m.velCurve = jmax(-1, jmin(1, j.nn("velCurve", 0)));
    m.bendRange = jmax(0, jmin(24, j.nn("bendRange", 2)));
    m.bendPiece = (int) j.nn("bendPiece", -1);
    const Json& cs = j.get("ccs");
    for (size_t i = 0; i < cs.size() && m.nCc < 16; i++) {
        const Json& e = cs.at(i); int cc = (int) e.nn("cc", -1); if (cc < 0 || cc > 127) continue;
        std::string t = e.str("target", "pedal");
        MidiMap::Cc& x = m.ccs[m.nCc++]; x.cc = cc; x.piece = (int) e.nn("piece", -1); x.invert = e.truthy("invert");
        x.target = t == "strike" ? MidiMap::Strike : t == "choke" ? MidiMap::Choke : MidiMap::Pedal;
    }
    return m;
}

static std::string noteId(int note) { return "n" + std::to_string(note); }

static std::unique_ptr<NoteMap> makeNoteMap(const Model& m)
{
    auto nm = std::make_unique<NoteMap>();
    const Json& cfg = m.cfg; nm->metal = m.metal; nm->hihat = m.metal && m.piece == "hihat";
    double th = cfg.get("strike").orv("theta", 0);
    for (int note = 0; note < 128; note++) {
        Stroke s; s.theta = th; bool ok = true;
        if (m.tongue && !m.tongues.empty()) {
            const Tongue* best = nullptr; double bd = 1e9;
            for (auto& t : m.tongues) { double d = std::fabs(t.note - note); if (d < bd) { bd = d; best = &t; } }
            if (!best || (m.bars && best->note != note)) ok = false;   // bars: keys outside the instrument stay silent
            else { s = Stroke(); s.tongue = best->idx; }
        } else if (cfg.str("kind") == "none" && !m.metal) ok = false;
        else {
            int pc = ((note % 12) + 12) % 12;
            if (m.metal) {
                const Json& top = cfg.get("special").get("top");
                double rb = top.truth() ? jmin(0.5, top.orv("bellDia", 0) / jmax(1, top.orv("diameter", 16))) : 0.3;
                const double R[12] = { 0.03, rb * 0.6, jmax(0.12, rb * 0.95), 0.35, 0.42, 0.52, 0.6, 0.67, 0.78, 0.82, 0.97, 0.94 };
                bool shoulder = pc == 1 || pc == 3 || pc == 6 || pc == 8 || pc == 10;
                s.r = R[pc]; s.mode = shoulder ? "shoulder" : "head";
            } else {
                if (pc == 11) { s.r = 0.97; s.mode = "rim"; }   /* B: the bare rim (stick on the hoop only) */
                else { s.r = pc / 10.0 * 0.95; s.mode = "head"; }
            }
        }
        nm->valid[note] = ok; nm->st[note] = s; if (ok) nm->any = true;
    }
    return nm;
}

std::unique_ptr<Player> Host::buildSingle(const Json& cfg, double gain, const Json& tr, bool calib, std::unique_ptr<NoteMap>* nmOut)
{
    auto m = buildModel(cfg, sr);
    if (calib) calibrate(*m, sr);
    else {
        m->gain = gain;
        if (tr.isArr()) { std::vector<double> t; for (auto& x : tr.a) t.push_back(x.toNum()); applyTrims(*m, &t); }
    }
    auto p = std::make_unique<Player>(sr);
    p->setModel(m);
    if (nmOut) *nmOut = makeNoteMap(*m);
    return p;
}

std::unique_ptr<Player> Host::buildPiece(const Json& cfgIn, double gain, const Json& tr, bool calib)
{
    Json cfg = cfgIn; if (calib) cfg.set("lite", Json::boolean(true));
    auto m = buildModel(cfg, sr);
    if (calib) calibrate(*m, sr);
    else {
        m->gain = gain;
        if (tr.isArr()) { std::vector<double> t; for (auto& x : tr.a) t.push_back(x.toNum()); applyTrims(*m, &t); }
    }
    auto p = std::make_unique<Player>(sr);
    Kit::preparePlayer(*p, m);
    return p;
}

std::unique_ptr<Kit> Host::buildKitFrom(const Json& pieces, const Json& map, double symp, bool calib)
{
    auto k = std::make_unique<Kit>(sr);
    for (size_t i = 0; i < pieces.size(); i++) {
        const Json& pc = pieces.at(i);
        auto p = buildPiece(pc.get("cfg"), pc.num("gain"), pc.get("tr"), calib);
        double lv = pc.num("level"), pn = pc.num("pan");
        k->swapPiece((int) i, std::move(p), pc.get("level").isNullish() ? nullptr : &lv, pc.get("pan").isNullish() ? nullptr : &pn);
    }
    auto mp = parseKitMap(map); k->swapMap(mp);
    k->symp = symp;
    return k;
}

std::unique_ptr<Cmd> Host::prepare(const Json& d)
{
    auto c = std::make_unique<Cmd>();
    const std::string t = d.str("type");
    if (t == "cfg") { c->kind = Cmd::Single; c->player = buildSingle(d.get("cfg"), d.num("gain"), d.get("tr"), false, &c->notes); }
    else if (t == "mode") { c->kind = Cmd::Mode; c->flag = d.truthy("kit"); }
    else if (t == "kit") { c->kind = Cmd::SetKit; c->kit = buildKitFrom(d.get("pieces"), d.get("map"), d.num("symp"), false); }
    else if (t == "kpiece") {
        c->kind = Cmd::KPiece; c->i = (int) d.num("i"); c->player = buildPiece(d.get("cfg"), d.num("gain"), d.get("tr"), false);
        c->hasLevel = !d.get("level").isNullish(); c->level = d.num("level"); c->hasPan = !d.get("pan").isNullish(); c->pan = d.num("pan");
    }
    else if (t == "ktrim") { c->kind = Cmd::KTrim; c->n = (int) d.num("n"); c->oldPlayers.reserve(16); }
    else if (t == "kmix") {
        c->kind = Cmd::KMix; c->symp = d.num("symp");
        for (auto& x : d.get("mix").a) c->mix.emplace_back(x.get("level").isNullish() ? NAN : x.num("level"), x.get("pan").isNullish() ? NAN : x.num("pan"));
    }
    else if (t == "kmap") { c->kind = Cmd::KMap; c->map = parseKitMap(d.get("map")); }
    else if (t == "kon") { c->kind = Cmd::KOn; c->note = (int) d.num("note"); c->vel = d.num("vel"); }
    else if (t == "koff") { c->kind = Cmd::KOff; c->note = (int) d.num("note"); }
    else if (t == "kpress") { c->kind = Cmd::KPress; c->hasId = !d.get("note").isNullish(); c->note = (int) d.num("note"); c->v = d.num("v"); }
    else if (t == "kcc") { c->kind = Cmd::KCc; c->num = (int) d.num("num"); c->v = d.num("v"); }
    else if (t == "punch") { c->kind = Cmd::Punch; c->v = d.num("v"); c->v2 = d.num("kv"); }
    else if (t == "panic") c->kind = Cmd::Panic;
    else if (t == "strike") { c->kind = Cmd::Strike; c->r = d.num("r"); c->theta = d.num("theta"); c->vel = d.num("vel"); c->mode = d.truthy("mode") ? d.str("mode") : "head"; }
    else if (t == "tongue") { c->kind = Cmd::Tongue; c->i = (int) d.num("idx"); c->vel = d.num("vel"); }
    else if (t == "on") { c->kind = Cmd::On; c->id = d.str("id"); c->st = strokeOf(d.get("st")); }
    else if (t == "off") { c->kind = Cmd::Off; c->id = d.str("id"); }
    else if (t == "press") { c->kind = Cmd::Press; c->hasId = !d.get("id").isNullish(); c->id = d.str("id"); c->v = d.num("v"); }
    else if (t == "cc") { c->kind = Cmd::Cc; c->num = (int) d.num("num"); c->v = d.num("v"); }
    else if (t == "choke") { c->kind = Cmd::Choke; c->v = d.num("v"); }
    else if (t == "pedal") {
        const Json& k = d.get("kind");
        if (k.isNum()) { c->kind = Cmd::PedalValue; c->v = k.n; } else { c->kind = Cmd::Pedal; c->kind2 = k.s; }
    }
    else if (t == "bus") { c->kind = Cmd::Bus; c->v = d.num("room"); c->v2 = d.num("master"); }
    else if (t == "midicfg") { c->kind = Cmd::Midi; c->midi = parseMidiMap(d.get("cfg")); }
    else return nullptr;
    return c;
}

std::vector<std::unique_ptr<Cmd>> Host::prepareFromStore(const Json& mode, const Json& data)
{
    std::vector<std::unique_ptr<Cmd>> out;
    bool asKit = mode.isStr() && mode.s == "kit" && data.get("pieces").isArr();
    const Json& mix = asKit ? data.get("mix") : data.get("mix");
    auto bus = std::make_unique<Cmd>(); bus->kind = Cmd::Bus; bus->v = mix.orv("room", 0); bus->v2 = mix.nn("master", 0.85); out.push_back(std::move(bus));
    auto pun = std::make_unique<Cmd>(); pun->kind = Cmd::Punch;
    pun->v = asKit ? pu : mix.nn("punch", 0.35); pun->v2 = asKit ? mix.nn("punch", 0.35) : kv; out.push_back(std::move(pun));
    if (asKit) {
        auto c = std::make_unique<Cmd>(); c->kind = Cmd::SetKit; c->kit = buildKitFrom(data.get("pieces"), data.get("map"), mix.nn("sympathy", 0.5), true);
        out.push_back(std::move(c));
    } else if (data.isObj()) {
        auto c = std::make_unique<Cmd>(); c->kind = Cmd::Single; c->player = buildSingle(data, 0, Json(), true, &c->notes);
        out.push_back(std::move(c));
        auto m = std::make_unique<Cmd>(); m->kind = Cmd::Mode; m->flag = false; out.push_back(std::move(m));
    }
    return out;
}

void Host::apply(Cmd& c)
{
    switch (c.kind) {
        case Cmd::Single:
            c.oldPlayer = std::move(single); single = std::move(c.player); single->punch = pu;
            c.oldNotes = std::move(notes); notes = std::move(c.notes); applyPitch();
            break;
        case Cmd::Mode: kitOn = c.flag; if (!kitOn && kit) kit->reset(); break;
        case Cmd::SetKit: c.oldKit = std::move(kit); kit = std::move(c.kit); kitOn = true; if (havePunch) kit->punch = kv; applyPitch(); break;
        case Cmd::KPiece:
            if (kit) { c.oldPlayer = kit->swapPiece(c.i, std::move(c.player), c.hasLevel ? &c.level : nullptr, c.hasPan ? &c.pan : nullptr); applyPitch(); }
            break;
        case Cmd::KTrim: if (kit) kit->trimInto(c.n, c.oldPlayers); break;
        case Cmd::KMix:
            if (kit) {
                for (size_t i = 0; i < c.mix.size(); i++) { double l = c.mix[i].first, p = c.mix[i].second; kit->setMix((int) i, l == l ? &l : nullptr, p == p ? &p : nullptr); }
                kit->symp = c.symp;
            }
            break;
        case Cmd::KMap: if (kit) kit->swapMap(c.map); break;
        case Cmd::KOn: if (kit) kit->noteOn(c.note, c.vel); break;
        case Cmd::KOff: if (kit) kit->noteOff(c.note); break;
        case Cmd::KPress: if (kit) kit->pressure(c.hasId ? &c.note : nullptr, c.v); break;
        case Cmd::KCc: if (kit) kit->cc(c.num, c.v); break;
        case Cmd::Punch: pu = c.v; kv = c.v2; havePunch = true; if (single) single->punch = pu; if (kit) kit->punch = kv; break;
        case Cmd::Panic: if (single) single->reset(); if (kit) kit->reset(); break;
        case Cmd::Strike: if (single) single->strike(c.r, c.theta, c.vel, c.mode); break;
        case Cmd::Tongue: if (single) single->strikeTongue(c.i, c.vel); break;
        case Cmd::On: if (single) single->noteOn(c.id, c.st); break;
        case Cmd::Off: if (single) single->noteOff(c.id); break;
        case Cmd::Press: if (single) single->pressure(c.hasId ? &c.id : nullptr, c.v); break;
        case Cmd::Cc: if (single) single->cc(c.num, c.v); break;
        case Cmd::Choke: if (single) single->choke(c.v); break;
        case Cmd::Pedal: if (single) single->pedal(c.kind2); break;
        case Cmd::PedalValue: if (single) single->pedalValue(c.v); break;
        case Cmd::Bus: room = c.v; master = c.v2; break;
        case Cmd::Midi: midi = c.midi; strikeOv = NAN; if (kit) for (int i = 0; i < (int) kit->pieces.size(); i++) kit->setStrikePos(i, NAN); applyPitch(); break;
        default: break;
    }
}

void Host::noteOn(int note, double vel)
{
    if (midi.velCurve) vel = std::pow(jmax(0, jmin(1, vel)), std::pow(3.0, -midi.velCurve));
    vel = jmax(0.02, vel);
    if (kitOn && kit) { kit->noteOn(note, vel); return; }
    if (!single || !notes || note < 0 || note > 127) return;
    if (notes->metal) {
        if (note == 96) { single->choke(1); return; }
        if (notes->hihat) { if (note == 98) { single->pedal("chick"); return; } if (note == 100) { single->pedal("splash"); return; } if (note == 97) { single->pedal("down"); return; } }
    }
    if (!notes->valid[note]) return;
    Stroke s = notes->st[note]; s.vel = vel;
    if (strikeOv == strikeOv && s.tongue < 0 && (s.mode == "head" || s.mode == "shoulder")) s.r = strikeOv;
    single->noteOn(noteId(note), s);
}
void Host::noteOff(int note)
{
    if (kitOn && kit) { kit->noteOff(note); return; }
    if (!single || !notes) return;
    if (notes->metal && note == 96) { single->choke(0); return; }
    if (notes->metal && note == 97) { single->pedal("up"); return; }
    single->noteOff(noteId(note));
}
void Host::polyPressure(int note, double v)
{
    if (kitOn && kit) { kit->pressure(&note, v); return; }
    if (single) { std::string id = noteId(note); single->pressure(&id, v); }
}
void Host::channelPressure(double v)
{
    if (kitOn && kit) { kit->pressure(nullptr, v); return; }
    if (single) single->pressure(nullptr, v);
}
void Host::controller(int cc, double v)
{
    if (cc == 120 || cc == 123) { if (cc == 120) { if (single) single->reset(); if (kit) kit->reset(); } return; }   // all sound off / all notes off
    bool used = false; bool k = kitOn && kit;
    for (int i = 0; i < midi.nCc; i++) {
        const MidiMap::Cc& e = midi.ccs[i]; if (e.cc != cc) continue;
        used = true; double x = e.invert ? 1 - v : v;
        if (e.target == MidiMap::Pedal) {
            if (k) { if (e.piece < 0) kit->cc(4, x); else kit->pedalPiece(e.piece, x); }
            else if (single) single->cc(4, x);
        } else if (e.target == MidiMap::Strike) {
            double r = 0.02 + 0.93 * x;   // 0: centre (bell on a cymbal), 1: edge
            if (k) { if (e.piece < 0) { for (int p = 0; p < (int) kit->pieces.size(); p++) kit->setStrikePos(p, r); } else kit->setStrikePos(e.piece, r); }
            else strikeOv = r;
        } else {
            if (k) { if (e.piece < 0) { for (int p = 0; p < (int) kit->pieces.size(); p++) kit->choke(p, x); } else kit->choke(e.piece, x); }
            else if (single) single->choke(x);
        }
    }
    if (!used && cc == 1) { if (k) kit->cc(1, v); else if (single) single->cc(1, v); }   // unassigned mod wheel: roll speed, as before
}
void Host::pitchBend(double b) { if (b == bend) return; bend = b; applyPitch(); }
void Host::applyPitch()
{
    double ratio = std::pow(2.0, bend * midi.bendRange / 12);
    if (kit) for (int p = 0; p < (int) kit->pieces.size(); p++) kit->setPitch(p, midi.bendPiece < 0 || midi.bendPiece == p ? ratio : 1);
    if (single && single->core) single->core->setPitch(ratio);
}
void Host::process(float* L, float* R, int n, float* const* outL, float* const* outR, int nOut)
{
    if (kitOn && kit) kit->process(L, n, R, outL, outR, nOut);
    else if (single) single->process(L, n, R);
    else for (int i = 0; i < n; i++) L[i] = R[i] = 0;
}

} // namespace dh
