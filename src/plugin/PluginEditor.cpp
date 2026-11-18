#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "dh_engine.h"

DrumheadEditor::DrumheadEditor(DrumheadProcessor& p) : AudioProcessorEditor(p)
{
    setSize(900, 560);
}

void DrumheadEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour(0xff15171c));
    g.setColour(juce::Colours::white);
    g.setFont(22.0f);
    g.drawText("Drumhead Lab", getLocalBounds().removeFromTop(80), juce::Justification::centred);
    g.setFont(14.0f);
    g.setColour(juce::Colours::grey);
    g.drawText(juce::String("engine ") + dh::kVersion + " - port in progress",
               getLocalBounds(), juce::Justification::centred);
}
