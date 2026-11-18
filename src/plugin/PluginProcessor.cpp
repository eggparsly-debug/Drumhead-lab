#include "PluginProcessor.h"
#include "PluginEditor.h"

DrumheadProcessor::DrumheadProcessor()
    : AudioProcessor(BusesProperties().withOutput("Main", juce::AudioChannelSet::stereo(), true))
{
}

bool DrumheadProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

void DrumheadProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    engine.prepare(sampleRate, samplesPerBlock);
}

void DrumheadProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    auto* L = buffer.getWritePointer(0);
    auto* R = buffer.getWritePointer(1);
    int pos = 0;
    // Split the block at each MIDI event so hits land sample-accurately.
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        const int at = juce::jlimit(pos, buffer.getNumSamples(), meta.samplePosition);
        if (at > pos) engine.process(L + pos, R + pos, at - pos);
        pos = at;
        if (m.isNoteOn()) engine.noteOn(m.getNoteNumber(), m.getFloatVelocity());
        else if (m.isNoteOff()) engine.noteOff(m.getNoteNumber());
        else if (m.isController()) engine.controller(m.getControllerNumber(), m.getControllerValue() / 127.0f);
    }
    if (pos < buffer.getNumSamples()) engine.process(L + pos, R + pos, buffer.getNumSamples() - pos);
}

juce::AudioProcessorEditor* DrumheadProcessor::createEditor() { return new DrumheadEditor(*this); }

void DrumheadProcessor::getStateInformation(juce::MemoryBlock&) {}
void DrumheadProcessor::setStateInformation(const void*, int) {}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new DrumheadProcessor(); }
