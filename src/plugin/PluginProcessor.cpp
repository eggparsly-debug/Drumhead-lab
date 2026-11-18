#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "BinaryData.h"

static const char* kDefaultKit = "Studio kit (pop / rock)";

// main stereo out + one stereo out per kit piece (off until enabled in the host; a piece with its own output
// leaves the main mix)
static juce::AudioProcessor::BusesProperties makeBuses()
{
    auto b = juce::AudioProcessor::BusesProperties().withOutput("Main", juce::AudioChannelSet::stereo(), true);
    for (int i = 1; i <= DrumheadProcessor::kPieceOuts; i++) b = b.withOutput("Piece " + juce::String(i), juce::AudioChannelSet::stereo(), false);
    return b;
}

DrumheadProcessor::DrumheadProcessor()
    : AudioProcessor(makeBuses()),
      params(*this, nullptr, "params", createLayout())
{
    auto kits = dh::Json::parse(std::string(BinaryData::kits_json, (size_t) BinaryData::kits_jsonSize));
    factoryKitJson = juce::String::fromUTF8(kits.get(kDefaultKit).dump().c_str());
    outGainDb = params.getRawParameterValue("out");
    ensureDefaultStore();
    worker = std::thread([this] { workerLoop(); });
    startTimerHz(20);
}

DrumheadProcessor::~DrumheadProcessor()
{
    stopTimer();
    { std::lock_guard<std::mutex> l(jobMutex); quit = true; jobs.clear(); }
    jobCv.notify_all();
    if (worker.joinable()) worker.join();
    for (auto* c : toAudio) delete c;
    timerCallback();
}

juce::AudioProcessorValueTreeState::ParameterLayout DrumheadProcessor::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    p.push_back(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID { "out", 1 }, "Output", juce::NormalisableRange<float>(-24.f, 12.f, 0.1f), 0.f,
        juce::AudioParameterFloatAttributes().withLabel("dB")));
    return { p.begin(), p.end() };
}

// ---------------- page settings ----------------
void DrumheadProcessor::ensureDefaultStore()
{
    const juce::ScopedLock sl(storeLock);
    if (store.find("drumlab.mode") == store.end()) {   // a fresh instance opens on the Studio kit
        store["drumlab.mode"] = "kit";
        store["drumlab.kit"] = factoryKitJson;
    }
}
void DrumheadProcessor::storeItem(const juce::String& key, const juce::String& value)
{
    const juce::ScopedLock sl(storeLock); store[key] = value;
}
juce::String DrumheadProcessor::storeJson() const
{
    dh::Json o = dh::Json::object();
    { const juce::ScopedLock sl(storeLock); for (auto& kv : store) o.set(kv.first.toStdString(), dh::Json::string(kv.second.toStdString())); }
    return juce::String::fromUTF8(o.dump().c_str());
}

// ---------------- worker ----------------
void DrumheadProcessor::queueJob(std::function<void()> job)
{
    { std::lock_guard<std::mutex> l(jobMutex); jobs.push_back(std::move(job)); }
    jobCv.notify_one();
}
void DrumheadProcessor::workerLoop()
{
    for (;;) {
        std::function<void()> job;
        {
            std::unique_lock<std::mutex> l(jobMutex);
            jobCv.wait(l, [this] { return quit || !jobs.empty(); });
            if (quit) return;
            job = std::move(jobs.front()); jobs.pop_front();
        }
        job();
    }
}
void DrumheadProcessor::push(std::unique_ptr<dh::Cmd> c)
{
    if (!c) return;
    if (c->kind == dh::Cmd::Single || c->kind == dh::Cmd::SetKit) instrumentReady = true;
    std::lock_guard<std::mutex> l(toAudioMutex); toAudio.push_back(c.release());
}
void DrumheadProcessor::uiMessage(const juce::String& json)
{
    std::string s = json.toStdString();
    queueJob([this, s] {
        dh::Json m = dh::Json::parse(s);
        std::lock_guard<std::mutex> l(hostMutex);
        if (!host || !m.isObj()) return;
        push(host->prepare(m));
    });
}
void DrumheadProcessor::queueRestore()
{
    queueJob([this] {
        dh::Json mode, data;
        {
            const juce::ScopedLock sl(storeLock);
            auto md = store.count("drumlab.mode") ? store["drumlab.mode"] : juce::String("single");
            mode = dh::Json::string(md.toStdString());
            auto key = md == "kit" ? "drumlab.kit" : "drumlab.cfg";
            data = dh::Json::parse(store.count(key) ? store[key].toStdString() : std::string());
        }
        dh::Json midiJ;
        { const juce::ScopedLock sl(storeLock); if (store.count("drumlab.midi")) midiJ = dh::Json::parse(store["drumlab.midi"].toStdString()); }
        std::lock_guard<std::mutex> l(hostMutex);
        if (!host) return;
        auto mc = std::make_unique<dh::Cmd>(); mc->kind = dh::Cmd::Midi; mc->midi = dh::parseMidiMap(midiJ); push(std::move(mc));
        if (!data.isObj()) return;
        for (auto& c : host->prepareFromStore(mode, data)) push(std::move(c));
    });
}

void DrumheadProcessor::timerCallback()
{
    // free whatever the audio thread retired
    int n = doneFifo.getNumReady();
    if (n > 0) {
        auto rd = doneFifo.read(n);
        for (int i = 0; i < rd.blockSize1; i++) delete done[(size_t) (rd.startIndex1 + i)];
        for (int i = 0; i < rd.blockSize2; i++) delete done[(size_t) (rd.startIndex2 + i)];
    }
}

// ---------------- audio ----------------
void DrumheadProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    {
        std::lock_guard<std::mutex> l(hostMutex);
        if (!host || sampleRate != currentSr) {
            { std::lock_guard<std::mutex> q(toAudioMutex); for (auto* c : toAudio) delete c; toAudio.clear(); }
            host = std::make_unique<dh::Host>(sampleRate);   // (audio is stopped while the host prepares us)
            currentSr = sampleRate; instrumentReady = false;
            queueRestore();
        }
    }
    juce::dsp::ProcessSpec spec { sampleRate, (juce::uint32) juce::jmax(1, samplesPerBlock), 2 };
    conv.prepare(spec);
    auto ir = dh::makeRoomIR(sampleRate);
    juce::AudioBuffer<float> b(2, (int) ir[0].size());
    for (int ch = 0; ch < 2; ch++) b.copyFrom(ch, 0, ir[(size_t) ch].data(), (int) ir[(size_t) ch].size());
    conv.loadImpulseResponse(std::move(b), sampleRate, juce::dsp::Convolution::Stereo::yes, juce::dsp::Convolution::Trim::no, juce::dsp::Convolution::Normalise::no);
    wet.setSize(2, juce::jmax(1, samplesPerBlock));
    for (auto& f : roomHP) { f.highpass(sampleRate, 120, 0.6); f.reset(); }
}

bool DrumheadProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
    for (int i = 1; i < layouts.outputBuses.size(); i++) {
        auto s = layouts.outputBuses[i];
        if (!s.isDisabled() && s != juce::AudioChannelSet::stereo()) return false;
    }
    return true;
}

void DrumheadProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    buffer.clear();
    if (!host) return;
    dh::Host& H = *host;

    // apply what the page / restore prepared, in order
    {
        std::unique_lock<std::mutex> l(toAudioMutex, std::try_to_lock);
        if (l.owns_lock()) {
            int room = doneFifo.getFreeSpace();
            while (!toAudio.empty() && room-- > 0) {
                dh::Cmd* c = toAudio.front(); toAudio.pop_front();
                H.apply(*c);
                auto wr = doneFifo.write(1);
                if (wr.blockSize1) done[(size_t) wr.startIndex1] = c; else done[(size_t) wr.startIndex2] = c;
            }
        }
    }

    auto mainBuf = getBusBuffer(buffer, false, 0);
    auto* L = mainBuf.getWritePointer(0);
    auto* R = mainBuf.getWritePointer(1);
    float* oL[kPieceOuts] = {}; float* oR[kPieceOuts] = {}; int nOut = 0;
    for (int i = 0; i < kPieceOuts && i + 1 < getBusCount(false); i++) {
        auto* bus = getBus(false, i + 1);
        if (bus && bus->isEnabled() && bus->getNumberOfChannels() == 2) {
            auto b = getBusBuffer(buffer, false, i + 1); oL[i] = b.getWritePointer(0); oR[i] = b.getWritePointer(1); nOut = i + 1;
        }
    }
    auto run = [&](int at, int len) {
        float* pl[kPieceOuts]; float* pr[kPieceOuts];
        for (int i = 0; i < nOut; i++) { pl[i] = oL[i] ? oL[i] + at : nullptr; pr[i] = oR[i] ? oR[i] + at : nullptr; }
        H.process(L + at, R + at, len, nOut ? pl : nullptr, nOut ? pr : nullptr, nOut);
    };
    int pos = 0;
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        int at = juce::jlimit(pos, n, meta.samplePosition);
        if (at > pos) { run(pos, at - pos); pos = at; }
        if (m.isNoteOn()) H.noteOn(m.getNoteNumber(), m.getFloatVelocity());
        else if (m.isNoteOff()) H.noteOff(m.getNoteNumber());
        else if (m.isAftertouch()) H.polyPressure(m.getNoteNumber(), m.getAfterTouchValue() / 127.0);
        else if (m.isChannelPressure()) H.channelPressure(m.getChannelPressureValue() / 127.0);
        else if (m.isController()) {
            H.controller(m.getControllerNumber(), m.getControllerValue() / 127.0);
            lastCc = m.getControllerNumber(); lastCcVal = m.getControllerValue(); lastCcSeq++;
        }
        else if (m.isPitchWheel()) H.pitchBend(juce::jlimit(-1.0, 1.0, (m.getPitchWheelValue() - 8192) / 8191.0));
    }
    if (pos < n) run(pos, n - pos);

    // bus (as the page's Web Audio graph): dry + room (high-passed at 120 Hz, convolved), master, soft clip
    if (wet.getNumSamples() < n) return;
    for (int ch = 0; ch < 2; ch++) {
        auto* src = mainBuf.getReadPointer(ch); auto* w = wet.getWritePointer(ch);
        for (int i = 0; i < n; i++) w[i] = roomHP[ch].run(src[i]);
    }
    juce::dsp::AudioBlock<float> wb(wet.getArrayOfWritePointers(), 2, (size_t) n);
    conv.process(juce::dsp::ProcessContextReplacing<float>(wb));
    const double kS = 1 - std::exp(-1.0 / (0.02 * currentSr));   // setTargetAtTime(..., 0.02)
    const float outG = juce::Decibels::decibelsToGain(outGainDb->load());
    for (int i = 0; i < nOut; i++) if (oL[i] && outG != 1.f) for (int k = 0; k < n; k++) { oL[i][k] *= outG; oR[i][k] *= outG; }
    auto* wl = wet.getReadPointer(0); auto* wr = wet.getReadPointer(1);
    for (int i = 0; i < n; i++) {
        roomS += kS * (H.room - roomS); masterS += kS * (H.master - masterS);
        float dry = (float) (1 - 0.3 * roomS), wg = (float) (roomS * 0.9), mg = (float) masterS;
        L[i] = dh::softClip((L[i] * dry + wl[i] * wg) * mg) * outG;
        R[i] = dh::softClip((R[i] * dry + wr[i] * wg) * mg) * outG;
    }
}

juce::AudioProcessorEditor* DrumheadProcessor::createEditor() { return new DrumheadEditor(*this); }

// ---------------- project state ----------------
void DrumheadProcessor::getStateInformation(juce::MemoryBlock& dest)
{
    auto state = params.copyState();
    state.setProperty("store", storeJson(), nullptr);
    state.setProperty("version", dh::kVersion, nullptr);
    if (auto xml = state.createXml()) copyXmlToBinary(*xml, dest);
}

void DrumheadProcessor::setStateInformation(const void* data, int size)
{
    auto xml = getXmlFromBinary(data, size);
    if (!xml) return;
    auto state = juce::ValueTree::fromXml(*xml);
    if (!state.isValid()) return;
    params.replaceState(state);
    dh::Json st = dh::Json::parse(state.getProperty("store").toString().toStdString());
    if (st.isObj()) {
        const juce::ScopedLock sl(storeLock);
        store.clear();
        for (auto& kv : st.o) store[juce::String::fromUTF8(kv.first.c_str())] = juce::String::fromUTF8(kv.second.s.c_str());
    }
    ensureDefaultStore();
    instrumentReady = false;
    std::lock_guard<std::mutex> l(hostMutex);
    if (host) queueRestore();
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new DrumheadProcessor(); }
