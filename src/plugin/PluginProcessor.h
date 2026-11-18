#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <thread>
#include <deque>
#include <map>
#include <mutex>
#include "dh_host.h"
#include "dh_room.h"

// The builder page (in the editor) and the project state drive a dh::Host. Messages are turned into commands on
// a worker thread (model building is slow), handed to the audio thread lock-free, and the objects they replace
// come back to be freed on the message thread.
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

    // ---- the builder page ----
    void uiMessage(const juce::String& json);                       // a message for the engine (same protocol as the browser)
    void storeItem(const juce::String& key, const juce::String& value);   // page settings, saved in the project
    juce::String storeJson() const;
    double uiSampleRate() const { return currentSr > 0 ? currentSr : 48000; }
    bool hasInstrument() const { return instrumentReady.load(); }

    juce::AudioProcessorValueTreeState params;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void timerCallback() override;
    void queueJob(std::function<void()> job);
    void workerLoop();
    void queueRestore();
    void push(std::unique_ptr<dh::Cmd> c);
    void ensureDefaultStore();

    // engine (rebuilt when the sample rate changes)
    std::unique_ptr<dh::Host> host;
    std::mutex hostMutex;                         // held by the worker while it builds, and by prepareToPlay
    double currentSr = 0;
    std::atomic<bool> instrumentReady { false };

    // commands: worker -> audio (mutex, audio thread only try-locks) and audio -> message thread (lock-free)
    std::mutex toAudioMutex; std::deque<dh::Cmd*> toAudio;
    juce::AbstractFifo doneFifo { 1024 }; std::array<dh::Cmd*, 1024> done {};

    // worker thread
    std::thread worker; std::mutex jobMutex; std::condition_variable jobCv; std::deque<std::function<void()>> jobs; bool quit = false;

    // page settings (localStorage in the browser)
    mutable juce::CriticalSection storeLock; std::map<juce::String, juce::String> store;
    juce::String factoryKitJson;

    // bus: room reverb, master, soft clip
    juce::dsp::Convolution conv { juce::dsp::Convolution::Latency { 0 } };
    juce::AudioBuffer<float> wet;
    dh::Biquad roomHP[2];
    double roomS = 0, masterS = 0.85;

    std::atomic<float>* outGainDb = nullptr;
    std::atomic<float>* pedalCC = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(DrumheadProcessor)
};
