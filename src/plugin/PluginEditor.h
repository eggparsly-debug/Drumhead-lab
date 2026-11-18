#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

class DrumheadProcessor;

// Temporary player window (step 2): pick a factory kit, click pads, set output and the hi-hat pedal CC.
// The full builder UI replaces this in step 4.
class DrumheadEditor : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit DrumheadEditor(DrumheadProcessor&);
    ~DrumheadEditor() override;
    void paint(juce::Graphics&) override;
    void resized() override;

private:
    struct Pad : juce::Component {
        Pad(DrumheadEditor& e, int n, juce::String l) : ed(e), note(n), label(std::move(l)) {}
        void paint(juce::Graphics&) override;
        void mouseDown(const juce::MouseEvent&) override;
        void mouseUp(const juce::MouseEvent&) override;
        DrumheadEditor& ed; int note; juce::String label; bool down = false;
    };
    void timerCallback() override;
    void rebuildPads();

    DrumheadProcessor& proc;
    juce::ComboBox kitBox;
    juce::Label status, outLabel, pedalLabel;
    juce::Slider outSlider, pedalSlider, velSlider;
    juce::Label velLabel;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> outAtt, pedalAtt;
    juce::OwnedArray<Pad> pads;
    int seenPads = -1;
};
