// Native counterpart of the browser's audio host (app.js makeHost): the builder page sends the same messages
// it sends to its AudioWorklet, and this applies them to the C++ engine.
//
// Threads: prepare() runs on a worker thread and does all the heavy work (building models, settling hats);
// apply(), MIDI and process() run on the audio thread and never allocate. A Cmd carries the built objects to
// the audio thread and carries the retired ones back so they are freed off the audio thread.
#pragma once
#include "dh_drum.h"
#include <array>
#include <memory>
#include <string>
#include <vector>

namespace dh {

constexpr const char* kVersion = "0.3.0";

// how a single build answers MIDI notes (precomputed off the audio thread)
struct NoteMap {
    bool metal = false, hihat = false, any = false;
    std::array<bool, 128> valid{}; std::array<Stroke, 128> st{};
};

struct Cmd {
    enum Kind { None, Single, Mode, SetKit, KPiece, KTrim, KMix, KMap, KOn, KOff, KPress, KCc, Punch, Panic,
                Strike, Tongue, On, Off, Press, Cc, Choke, Pedal, PedalValue, Bus };
    Kind kind = None;
    std::unique_ptr<Player> player; std::unique_ptr<Kit> kit; std::unique_ptr<NoteMap> notes;
    int i = 0, n = 0, note = 0, num = 0; bool flag = false, hasLevel = false, hasPan = false, hasId = false;
    double v = 0, v2 = 0, level = 0, pan = 0, r = 0, theta = 0, vel = 0, symp = NAN;
    std::string id, mode, kind2; Stroke st;
    std::vector<std::pair<double, double>> mix; std::vector<std::pair<int, Slot>> map;
    // filled on the audio thread: what the command replaced
    std::unique_ptr<Player> oldPlayer; std::unique_ptr<Kit> oldKit; std::unique_ptr<NoteMap> oldNotes;
    std::vector<std::unique_ptr<Player>> oldPlayers;
};

class Host {
public:
    explicit Host(double sr) : sr(sr) {}
    double sampleRate() const { return sr; }

    // ---- worker thread ----
    std::unique_ptr<Cmd> prepare(const Json& msg);                    // a message from the builder page
    std::vector<std::unique_ptr<Cmd>> prepareFromStore(const Json& mode, const Json& kitOrCfg);   // restore a saved project (calibrates natively)

    // ---- audio thread ----
    void apply(Cmd& c);
    void noteOn(int note, double vel);
    void noteOff(int note);
    void polyPressure(int note, double v);
    void channelPressure(double v);
    void controller(int cc, double v, int pedalCC);
    void process(float* L, float* R, int n);
    bool kitMode() const { return kitOn; }

    // bus settings the plugin applies after the engine (room reverb, master)
    double room = 0, master = 0.85;

private:
    std::unique_ptr<Player> buildSingle(const Json& cfg, double gain, const Json& tr, bool calibrateHere, std::unique_ptr<NoteMap>* notes);
    std::unique_ptr<Player> buildPiece(const Json& cfg, double gain, const Json& tr, bool calibrateHere);
    std::unique_ptr<Kit> buildKitFrom(const Json& pieces, const Json& map, double symp, bool calibrateHere);

    double sr;
    std::unique_ptr<Player> single; std::unique_ptr<NoteMap> notes;
    std::unique_ptr<Kit> kit; bool kitOn = false;
    double pu = 0, kv = 0; bool havePunch = false;   // (no punch until the page or the project sets it, as in the browser)
};

} // namespace dh
