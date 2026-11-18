// Drumhead Lab sound engine: a line-for-line C++ port of reference/engine.js.
// Keep the two in step: every physics change is made in engine.js first, then ported here,
// and `dhrender --compare` must still match the browser renders.
#pragma once
#include "dh_json.h"
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace dh {

// ---------------- material tables ----------------
struct HeadMat { std::string name; double rho, E, eta, hf, coat, thick; bool metal; double ys; };
struct ShellMat { std::string name; double rho, E, Q, absorb; };
struct HoopMat { std::string name; double E, rho, heff, area, Q; };
struct Mallet {
    std::string name; double mass, tau, alpha, rc, lam, vmax;
    std::vector<std::array<double, 3>> ring; double click; bool brush = false, bow = false;
};
struct Alloy { std::string name; double rho, E, eta; };

const HeadMat* headMat(const std::string& key);
const ShellMat* shellMat(const std::string& key);
const HoopMat* hoopMat(const std::string& key);
const Mallet* mallet(const std::string& key);   // nullptr if unknown
const Alloy* alloy(const std::string& key);
extern const Mallet BRUSH_MALLET, BOW_MALLET;

double midiHz(double n);

// ---------------- model data ----------------
enum class MS : uint8_t { None, Plate, Bell, Bowl, Proxy };
enum class Body : uint8_t { None, Bowl, GBowl, Stem, Tube };

struct Tongue {
    int idx = 0; double note = 0, f = 0, L = 0, w = 0, th = 0, hw = 0, rb = 0.94, ln = 0.8;
    bool bar = false, tooLong = false; double clk = 0, og = 0;
};

struct Mode {
    double m = 0, n = 0, j = 0, k = 0, w = 0, f = 0, M = 0, alpha = 0, S = 0, rimF = 0;
    double outW = 0, outW0 = NAN, tmw = 0, frac = 0;
    int orient = 0;            // -1 = undefined (metal proxies)
    bool proxy = false; double a0 = 0, amp = 0, ph = 0;
    int partial = 0; int tg = -1; bool bar = false; Body body = Body::None;
    // metal
    MS ms = MS::None; double phi = 0, rb = 0; int which = -1; double taper = 0, spread = 0, lam = 0;
    bool cup = false, boss = false;
};

struct Head {
    std::vector<Mode> modes; double sigma = 0, T = 0, tmCoef = 0, a = 0; bool metal = false;
    std::vector<Tongue> tongues;
};

struct Res { double w = 0, M = 0, alpha = 0, rad = 1; };
struct Port { double A = 0, L = 0, Q = 0, mp = 0, wH = 0, alpha = 0; };

struct PlateSet {
    std::vector<Mode> modes; double a = 0, mass = 0; const Alloy* A = nullptr; double heff = 0, cbar = 0, rb = 0, D = 0;
};

struct Model {
    bool metal = false; Json cfg;
    // drums, bodies, tuned
    bool two = false, none = false, tongue = false, bars = false;
    double a = 0, aR = 0, V = 1, Kc = 0;
    bool hasPort = false; Port port;
    std::vector<Tongue> tongues;          // (shared by B.modes[].tg indices)
    Head B; bool hasR = false; Head R;
    std::vector<Res> airModes, shell, hoop;
    ShellMat SM{};
    bool snareOn = false; double snareTension = 0.5, snareLevel = 0;
    const Mallet* mallet = nullptr;
    Json mics, mix;
    double gain = 1; bool cal = false;
    // metal
    std::string piece; bool pair = false; double dark = 0;
    PlateSet top, bot; bool hasBot = false;
    std::vector<Mode> modes; int nTop = 0;
    double gamma = 0, bloom = 1, glide = 0, rivets = 0; bool chain = false;
    double hhClutch = 0.6, hhTilt = 0.3, hhGap = 8, hhOpen = 0.15, hhPress = 0.5;
};

std::shared_ptr<Model> buildModel(const Json& cfg, double sr);
double modeShape(const Model& model, const Mode& md, double r, double th);
void applyTrims(Model& model, const std::vector<double>* tr);
std::vector<double> trimsOf(const Model& model);
double calibrate(Model& model, double sr);

// ---------------- real-time cores ----------------
struct Pulse { double t, dur, amp, hoop, head; const std::vector<double>* psi; std::shared_ptr<std::vector<double>> own; };
struct Contact {   // a mallet in contact with the surface
    std::vector<double> psi; double Y = 0, y = 0, v = 0, v0 = 0, m = 0, kc = 0, al = 0, loss = 0, h = 0, hv = 0, F = 0, life = 0;
    bool hit = false, gone = false;
};

class Core {
public:
    virtual ~Core() = default;
    virtual bool isMetal() const = 0;
    virtual void setModel(std::shared_ptr<Model> m) = 0;
    virtual void strike(double r, double th, double vel, const std::string& mode, const Mallet* ml = nullptr) = 0;
    virtual void addPulse(double r, double th, double amp, double dur, double delay) = 0;
    virtual void setChoke(double x) { chkT = x < 0 ? 0 : x > 1 ? 1 : x; }
    virtual void reset() = 0;
    virtual void settle() = 0;
    virtual void process(float* out, int n, float* outR) = 0;
    virtual bool hasTongues() const { return false; }
    virtual void strikeTongue(int, double) {}
    virtual bool hasPedal() const { return false; }
    virtual void setPedal(double) {}
    virtual void pedalSplash(double) {}
    virtual void bowStart(double, double, double) {}
    virtual void bowPressure(double) {}
    virtual void bowStop() {}
    virtual bool bowOn() const { return false; }

    std::shared_ptr<Model> model;
    std::vector<Contact> mallets;
    std::vector<Pulse> pulses;
    bool needSettle = false, kitMode = false;
    double extP = 0, chk = 0, chkT = 0;
    double sinceHit = 0;
};

std::unique_ptr<Core> makeVoice(double sr);
std::unique_ptr<Core> makeMetal(double sr);

// ---------------- player: techniques layer + output stage ----------------
struct Stroke { double r = NAN, theta = 0, vel = 0; std::string mode = "head"; int tongue = -1; };

class Player {
public:
    explicit Player(double sr);
    void setModel(std::shared_ptr<Model> m);
    void strike(double r, double th, double vel, const std::string& mode);
    void strikeTongue(int i, double vel);
    void noteOn(const std::string& id, const Stroke& st);
    void noteOff(const std::string& id);
    void pressure(const std::string* id, double v);
    void choke(double v);
    void cc(int num, double v);
    void pedal(const std::string& kind);
    void pedalValue(double open);
    void reset();
    void process(float* outL, int n, float* outR);

    // output-stage helpers (also used by the kit bus)
    double post(double y0, double* ts, double* dc);
    double punchGain(double l, double r, double pu);
    static double soft(double x);

    double sr; std::unique_ptr<Core> core; std::shared_ptr<Model> model;
    double gain = 1, punch = 0, shelfG = 0, lowG = 0, gT = 0, gL = 0, rollRate = 14;
    bool inKit = false, asleep = false; double quietThr = 1.5e-5, quietN = 0;
    double dcL[8] = {}, dcR[8] = {}, tL[2] = {}, tR[2] = {};
    double hpA[5], hpB[5];
    int LA; std::vector<float> laL, laR, laG; int laI = 0, laN = 0; double lg = 1, kAtk, kRel, CEIL = 0.93;

private:
    struct Roll { std::string id; Stroke st; double lvl, max; bool hasMax; double next; int hand; double ang; };
    struct Event { double at; int kind; double base; };
    void wake() { asleep = false; quietN = 0; }
    double rand();
    bool isBrush() const;
    bool isBow() const;
    void brushHit(double r, double th, double vel);
    void runRolls();
    const Tongue* tongueOf(int i) const;
    std::vector<Roll> rolls; std::vector<Event> events;
    double t = 0; uint32_t seed = 1234;
    double swish = 0, sw1 = 0, sw2 = 0, sw3 = 0;
    double pedalBase = NAN; bool footDown = false; std::string bowId; bool hasBowId = false;
    bool pInit = false; double pA = 0, pR = 0, pE = 0;
    std::vector<float> tmpL, tmpR;
};

// ---------------- kit ----------------
struct Slot {
    int p = 0; double r = NAN, theta = 0; std::string mode; int tongue = -1; double open = NAN; std::string pedal;
};

class Kit {
public:
    explicit Kit(double sr);
    struct Piece { std::unique_ptr<Player> player; double level = 1, pan = 0, lp = 0, drive = 0, recv = 1; bool drum = false, hat = false; };
    void setPiece(int i, std::shared_ptr<Model> m, const double* level, const double* pan);
    void setMix(int i, const double* level, const double* pan);
    void trim(int n);
    void setMap(const std::vector<std::pair<int, Slot>>& map);
    void noteOn(int note, double vel);
    void noteOff(int note);
    void pressure(const int* note, double v);
    void choke(int i, double v);
    void cc(int num, double v);
    void reset();
    void process(float* L, int n, float* R);
    // real-time-safe edits used by the plugin host (no allocation on the audio thread)
    std::unique_ptr<Player> swapPiece(int i, std::unique_ptr<Player> p, const double* level, const double* pan);
    void trimInto(int n, std::vector<std::unique_ptr<Player>>& out);
    void swapMap(std::vector<std::pair<int, Slot>>& m) { map.swap(m); }
    static void preparePlayer(Player& p, std::shared_ptr<Model> m);   // what setPiece does to a fresh player

    double sr, symp = 0.5, punch = 0, out = NAN;
    std::vector<Piece> pieces;
private:
    const Slot* slotOf(int note) const;
    std::vector<std::pair<int, Slot>> map;
    std::vector<std::pair<int, Slot>> held;
    std::vector<float> tLb, tRb;
    std::unique_ptr<Player> bus;
};

std::vector<std::pair<int, Slot>> parseKitMap(const Json& map);

} // namespace dh
