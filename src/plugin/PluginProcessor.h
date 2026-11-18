#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <atomic>
#include "dh_engine.h"

class DrumheadProcessor : public juce::AudioProcessor, private juce::Timer {
public:
    DrumheadProcessor();
    ~DrumheadProcessor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Drumhead Lab"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 8.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;

    // ---- for the editor ----
    juce::StringArray factoryKitNames() const;
    void loadFactoryKit(const juce::String& name);
    juce::String currentKitName() const { const juce::ScopedLock sl(infoLock); return kitName; }
    juce::String statusText() const { const juce::ScopedLock sl(infoLock); return status; }
    std::vector<dh::Pad> currentPads() const { const juce::ScopedLock sl(infoLock); return pads; }
    int padsVersion() const { return padsVer.load(); }

    juce::MidiKeyboardState keyboardState;
    juce::AudioProcessorValueTreeState params;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void startBuild(const dh::Json& kitJson, double sr);
    void timerCallback() override;

    dh::Json factoryKits;
    std::unique_ptr<dh::Instrument> live;                 // audio thread only
    std::atomic<dh::Instrument*> pending { nullptr };    // built, waiting to go live
    std::atomic<dh::Instrument*> trash { nullptr };      // retired, freed on the message thread
    juce::ThreadPool builder { 1 };
    std::atomic<int> buildGen { 0 };
    double currentSr = 0;

    juce::CriticalSection infoLock;
    juce::String kitName, status { "starting" };
    std::vector<dh::Pad> pads; std::atomic<int> padsVer { 0 };
    dh::Json kitSource;

    std::atomic<float>* outGainDb = nullptr;
    std::atomic<float>* pedalCC = nullptr;
    std::vector<float> tmpL, tmpR;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(DrumheadProcessor)
};
