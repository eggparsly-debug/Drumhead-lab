#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "BinaryData.h"

static const char* kDefaultKit = "Studio kit (pop / rock)";

DrumheadProcessor::DrumheadProcessor()
    : AudioProcessor(BusesProperties().withOutput("Main", juce::AudioChannelSet::stereo(), true)),
      params(*this, nullptr, "params", createLayout())
{
    auto kits = dh::Json::parse(std::string(BinaryData::kits_json, (size_t) BinaryData::kits_jsonSize));
    factoryKitJson = juce::String::fromUTF8(kits.get(kDefaultKit).dump().c_str());
    outGainDb = params.getRawParameterValue("out");
    pedalCC = params.getRawParameterValue("pedalcc");
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
    p.push_back(std::make_unique<juce::AudioParameterInt>(juce::ParameterID { "pedalcc", 1 }, "Hi-hat pedal CC", 1, 119, 1));
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
        std::lock_guard<std::mutex> l(hostMutex);
        if (!host || !data.isObj()) return;
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
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
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

    auto* L = buffer.getWritePointer(0);
    auto* R = buffer.getWritePointer(1);
    const int pedalNum = (int) pedalCC->load();
    int pos = 0;
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        int at = juce::jlimit(pos, n, meta.samplePosition);
        if (at > pos) { H.process(L + pos, R + pos, at - pos); pos = at; }
        if (m.isNoteOn()) H.noteOn(m.getNoteNumber(), m.getFloatVelocity());
        else if (m.isNoteOff()) H.noteOff(m.getNoteNumber());
        else if (m.isAftertouch()) H.polyPressure(m.getNoteNumber(), m.getAfterTouchValue() / 127.0);
        else if (m.isChannelPressure()) H.channelPressure(m.getChannelPressureValue() / 127.0);
        else if (m.isController()) H.controller(m.getControllerNumber(), m.getControllerValue() / 127.0, pedalNum);
    }
    if (pos < n) H.process(L + pos, R + pos, n - pos);

    // bus (as the page's Web Audio graph): dry + room (high-passed at 120 Hz, convolved), master, soft clip
    if (wet.getNumSamples() < n) return;
    for (int ch = 0; ch < 2; ch++) {
        auto* src = buffer.getReadPointer(ch); auto* w = wet.getWritePointer(ch);
        for (int i = 0; i < n; i++) w[i] = roomHP[ch].run(src[i]);
    }
    juce::dsp::AudioBlock<float> wb(wet.getArrayOfWritePointers(), 2, (size_t) n);
    conv.process(juce::dsp::ProcessContextReplacing<float>(wb));
    const double kS = 1 - std::exp(-1.0 / (0.02 * currentSr));   // setTargetAtTime(..., 0.02)
    const float outG = juce::Decibels::decibelsToGain(outGainDb->load());
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
