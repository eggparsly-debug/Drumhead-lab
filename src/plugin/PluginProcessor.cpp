#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "BinaryData.h"

static const char* kDefaultKit = "Studio kit (pop / rock)";

DrumheadProcessor::DrumheadProcessor()
    : AudioProcessor(BusesProperties().withOutput("Main", juce::AudioChannelSet::stereo(), true)),
      params(*this, nullptr, "params", createLayout())
{
    factoryKits = dh::Json::parse(std::string(BinaryData::kits_json, (size_t) BinaryData::kits_jsonSize));
    kitName = kDefaultKit;
    outGainDb = params.getRawParameterValue("out");
    pedalCC = params.getRawParameterValue("pedalcc");
    startTimerHz(10);
}

DrumheadProcessor::~DrumheadProcessor()
{
    stopTimer();
    builder.removeAllJobs(true, 30000);
    delete pending.exchange(nullptr);
    delete trash.exchange(nullptr);
}

juce::AudioProcessorValueTreeState::ParameterLayout DrumheadProcessor::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    p.push_back(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID { "out", 1 }, "Output", juce::NormalisableRange<float>(-24.f, 12.f, 0.1f), 0.f,
        juce::AudioParameterFloatAttributes().withLabel("dB")));
    p.push_back(std::make_unique<juce::AudioParameterInt>(juce::ParameterID { "pedalcc", 1 }, "Hi-hat pedal CC", 1, 119, 1));
    return { p.begin(), p.end() };
}

juce::StringArray DrumheadProcessor::factoryKitNames() const
{
    juce::StringArray s; for (auto& kv : factoryKits.o) s.add(juce::String::fromUTF8(kv.first.c_str()));
    return s;
}

void DrumheadProcessor::loadFactoryKit(const juce::String& name)
{
    const dh::Json& k = factoryKits.get(name.toStdString());
    if (!k.isObj()) return;
    { const juce::ScopedLock sl(infoLock); kitName = name; kitSource = k; }
    if (currentSr > 0) startBuild(k, currentSr);
}

void DrumheadProcessor::startBuild(const dh::Json& kitJson, double sr)
{
    int gen = ++buildGen;
    { const juce::ScopedLock sl(infoLock); status = "building " + juce::String::fromUTF8(kitJson.str("name").c_str()) + " ..."; }
    builder.addJob([this, kitJson, sr, gen]() {
        auto t0 = juce::Time::getMillisecondCounterHiRes();
        auto inst = dh::buildKit(kitJson, sr);
        if (gen != buildGen.load()) return;   // superseded by a newer request
        auto ms = juce::Time::getMillisecondCounterHiRes() - t0;
        {
            const juce::ScopedLock sl(infoLock);
            pads = inst->pads; padsVer++;
            status = juce::String::fromUTF8(inst->name.c_str()) + "  -  ready (" + juce::String((int) ms) + " ms build, " + juce::String((int) sr) + " Hz)";
        }
        delete pending.exchange(inst.release());
    });
}

void DrumheadProcessor::timerCallback()
{
    delete trash.exchange(nullptr);   // free retired instruments off the audio thread
}

void DrumheadProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    keyboardState.reset();
    tmpL.assign((size_t) juce::jmax(512, samplesPerBlock), 0.f);
    tmpR.assign(tmpL.size(), 0.f);
    if (sampleRate != currentSr) {
        currentSr = sampleRate;
        dh::Json k; { const juce::ScopedLock sl(infoLock); k = kitSource; }
        if (!k.isObj()) { k = factoryKits.get(kDefaultKit); const juce::ScopedLock sl(infoLock); kitSource = k; }
        startBuild(k, sampleRate);
    }
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
    keyboardState.processNextMidiBuffer(midi, 0, n, true);   // pads clicked in the editor

    if (pending.load() && trash.load() == nullptr) {
        if (auto* p = pending.exchange(nullptr)) { trash.store(live.release()); live.reset(p); }
    }
    if (!live) return;

    if ((int) tmpL.size() < n) return;   // host sent a bigger block than promised: stay silent rather than allocate
    auto* L = buffer.getWritePointer(0);
    auto* R = buffer.getWritePointer(1);
    const int pedalNum = (int) pedalCC->load();
    int pos = 0;
    auto render = [&](int upTo) {
        while (pos < upTo) {
            int len = juce::jmin(upTo - pos, (int) tmpL.size());
            live->process(tmpL.data(), tmpR.data(), len);
            std::copy(tmpL.begin(), tmpL.begin() + len, L + pos);
            std::copy(tmpR.begin(), tmpR.begin() + len, R + pos);
            pos += len;
        }
    };
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        render(juce::jlimit(pos, n, meta.samplePosition));
        if (m.isNoteOn()) live->noteOn(m.getNoteNumber(), m.getFloatVelocity());
        else if (m.isNoteOff()) live->noteOff(m.getNoteNumber());
        else if (m.isController()) {
            int cc = m.getControllerNumber(); double v = m.getControllerValue() / 127.0;
            if (cc == 4 || cc == pedalNum) live->hatPedal(v);
        }
    }
    render(n);
    const float g = juce::Decibels::decibelsToGain(outGainDb->load());
    if (g != 1.f) buffer.applyGain(g);
}

juce::AudioProcessorEditor* DrumheadProcessor::createEditor() { return new DrumheadEditor(*this); }

void DrumheadProcessor::getStateInformation(juce::MemoryBlock& dest)
{
    auto state = params.copyState();
    { const juce::ScopedLock sl(infoLock); state.setProperty("kit", kitName, nullptr); state.setProperty("kitJson", juce::String::fromUTF8(kitSource.dump().c_str()), nullptr); }
    if (auto xml = state.createXml()) copyXmlToBinary(*xml, dest);
}

void DrumheadProcessor::setStateInformation(const void* data, int size)
{
    auto xml = getXmlFromBinary(data, size);
    if (!xml) return;
    auto state = juce::ValueTree::fromXml(*xml);
    if (!state.isValid()) return;
    params.replaceState(state);
    auto js = state.getProperty("kitJson").toString();
    dh::Json k = dh::Json::parse(js.toStdString());
    if (!k.isObj()) k = factoryKits.get(state.getProperty("kit").toString().toStdString());
    if (k.isObj()) {
        { const juce::ScopedLock sl(infoLock); kitName = state.getProperty("kit").toString(); kitSource = k; }
        if (currentSr > 0) startBuild(k, currentSr);
    }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new DrumheadProcessor(); }
