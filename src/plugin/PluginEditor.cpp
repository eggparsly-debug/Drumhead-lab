#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "dh_engine.h"

namespace {
const juce::Colour bg(0xff15171c), panel(0xff1f232b), accent(0xffd9a441), text(0xffe8e6e1), dim(0xff8a8f99);
}

DrumheadEditor::DrumheadEditor(DrumheadProcessor& p) : AudioProcessorEditor(p), proc(p)
{
    kitBox.addItemList(proc.factoryKitNames(), 1);
    kitBox.setText(proc.currentKitName(), juce::dontSendNotification);
    kitBox.onChange = [this] { proc.loadFactoryKit(kitBox.getText()); };
    addAndMakeVisible(kitBox);

    status.setColour(juce::Label::textColourId, dim);
    addAndMakeVisible(status);

    auto setupSlider = [this](juce::Slider& s, juce::Label& l, const char* name) {
        s.setSliderStyle(juce::Slider::LinearHorizontal);
        s.setTextBoxStyle(juce::Slider::TextBoxRight, false, 64, 20);
        l.setText(name, juce::dontSendNotification); l.setColour(juce::Label::textColourId, text);
        addAndMakeVisible(s); addAndMakeVisible(l);
    };
    setupSlider(outSlider, outLabel, "Output (dB)");
    setupSlider(pedalSlider, pedalLabel, "Hi-hat pedal CC");
    setupSlider(velSlider, velLabel, "Pad velocity");
    velSlider.setRange(0.05, 1.0, 0.01); velSlider.setValue(0.85);
    outAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(proc.params, "out", outSlider);
    pedalAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(proc.params, "pedalcc", pedalSlider);

    setResizable(true, true);
    setResizeLimits(640, 420, 1600, 1200);
    setSize(900, 560);
    startTimerHz(10);
    timerCallback();
}

DrumheadEditor::~DrumheadEditor() { stopTimer(); }

void DrumheadEditor::timerCallback()
{
    status.setText(proc.statusText(), juce::dontSendNotification);
    if (proc.padsVersion() != seenPads) { seenPads = proc.padsVersion(); rebuildPads(); }
}

void DrumheadEditor::rebuildPads()
{
    pads.clear();
    for (auto& p : proc.currentPads()) {
        auto* pad = pads.add(new Pad(*this, p.note, juce::String(p.note) + "\n" + juce::String::fromUTF8(p.label.c_str())));
        addAndMakeVisible(pad);
    }
    resized();
}

void DrumheadEditor::paint(juce::Graphics& g)
{
    g.fillAll(bg);
    g.setColour(accent);
    g.setFont(juce::FontOptions(22.0f, juce::Font::bold));
    g.drawText("Drumhead Lab", 16, 10, 300, 30, juce::Justification::centredLeft);
    g.setColour(dim);
    g.setFont(juce::FontOptions(12.0f));
    g.drawText(juce::String("engine ") + dh::kVersion + "  -  kit player (builder UI coming next)", getWidth() - 416, 14, 400, 22, juce::Justification::centredRight);
}

void DrumheadEditor::resized()
{
    auto r = getLocalBounds().reduced(16);
    r.removeFromTop(36);
    auto row = r.removeFromTop(30);
    kitBox.setBounds(row.removeFromLeft(320));
    row.removeFromLeft(12);
    status.setBounds(row);
    r.removeFromTop(10);
    for (auto pr : { std::make_pair(&outLabel, &outSlider), std::make_pair(&pedalLabel, &pedalSlider), std::make_pair(&velLabel, &velSlider) }) {
        auto line = r.removeFromTop(28);
        pr.first->setBounds(line.removeFromLeft(130));
        pr.second->setBounds(line.removeFromLeft(360));
    }
    r.removeFromTop(12);
    if (pads.isEmpty()) return;
    int cols = juce::jmax(3, r.getWidth() / 130), rows = (pads.size() + cols - 1) / cols;
    int w = r.getWidth() / cols, h = juce::jmin(90, r.getHeight() / juce::jmax(1, rows));
    for (int i = 0; i < pads.size(); i++)
        pads[i]->setBounds(r.getX() + (i % cols) * w, r.getY() + (i / cols) * h, w - 6, h - 6);
}

void DrumheadEditor::Pad::paint(juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat();
    g.setColour(down ? accent.withAlpha(0.85f) : panel);
    g.fillRoundedRectangle(b, 6.f);
    g.setColour(down ? bg : text);
    g.setFont(juce::FontOptions(13.0f));
    g.drawFittedText(label, getLocalBounds().reduced(6), juce::Justification::centred, 3);
}
void DrumheadEditor::Pad::mouseDown(const juce::MouseEvent&)
{
    down = true; repaint();
    ed.proc.keyboardState.noteOn(1, note, (float) ed.velSlider.getValue());
}
void DrumheadEditor::Pad::mouseUp(const juce::MouseEvent&)
{
    down = false; repaint();
    ed.proc.keyboardState.noteOff(1, note, 0.f);
}
