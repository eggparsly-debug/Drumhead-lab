#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

class DrumheadProcessor;

// The plugin window is the Drumhead Lab builder page itself (the same page as the browser prototype), shown in
// an embedded WebView2. The page sends its engine messages and settings here instead of to Web Audio.
class DrumheadEditor : public juce::AudioProcessorEditor {
public:
    explicit DrumheadEditor(DrumheadProcessor&);
    ~DrumheadEditor() override;
    void paint(juce::Graphics&) override;
    void resized() override;

private:
    static juce::WebBrowserComponent::Options makeOptions(DrumheadProcessor&);
    DrumheadProcessor& proc;
    juce::WebBrowserComponent web;
};
