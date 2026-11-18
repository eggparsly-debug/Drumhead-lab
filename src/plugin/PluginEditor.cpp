#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "BinaryData.h"

namespace {
// Defines window.__DH_PLUGIN before the page's own scripts run: the sample rate, the saved page settings
// (the page's localStorage), and the two channels back to the plugin.
juce::String bridgeScript(DrumheadProcessor& p)
{
    juce::String s;
    s << "window.__DH_PLUGIN = (function () {\n"
      << "  var S = " << p.storeJson() << ";\n"
      << "  function emit(id, o) { try { window.__JUCE__.backend.emitEvent(id, o); } catch (e) {} }\n"
      << "  return {\n"
      << "    sr: " << juce::String(p.uiSampleRate(), 1) << ", hasInstrument: " << (p.hasInstrument() ? "true" : "false") << ", live: false,\n"
      << "    store: {\n"
      << "      getItem: function (k) { return Object.prototype.hasOwnProperty.call(S, k) ? S[k] : null; },\n"
      << "      setItem: function (k, v) { v = String(v); if (S[k] === v) return; S[k] = v; emit('dhstore', { k: k, v: v }); }\n"
      << "    },\n"
      << "    send: function (m) { emit('dhmsg', { s: JSON.stringify(m) }); }\n"
      << "  };\n"
      << "})();\n";
    return s;
}
std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String& url)
{
    auto path = url.upToFirstOccurrenceOf("?", false, false);
    if (path == "/" || path == "/index.html") {
        juce::WebBrowserComponent::Resource r;
        auto* d = reinterpret_cast<const std::byte*>(BinaryData::index_html);
        r.data.assign(d, d + BinaryData::index_htmlSize);
        r.mimeType = "text/html";
        return r;
    }
    return std::nullopt;
}
}

juce::WebBrowserComponent::Options DrumheadEditor::makeOptions(DrumheadProcessor& p)
{
    using O = juce::WebBrowserComponent::Options;
    return O {}
        .withBackend(O::Backend::webview2)
        .withWinWebView2Options(O::WinWebView2 {}
            .withUserDataFolder(juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("DrumheadLab-WebView2"))
            .withBackgroundColour(juce::Colour(0xff15171c))
            .withStatusBarDisabled())
        .withNativeIntegrationEnabled()
        .withUserScript(bridgeScript(p))
        .withEventListener("dhmsg", [&p](juce::var o) { p.uiMessage(o["s"].toString()); })
        .withEventListener("dhstore", [&p](juce::var o) { p.storeItem(o["k"].toString(), o["v"].toString()); })
        .withResourceProvider(resource);
}

DrumheadEditor::DrumheadEditor(DrumheadProcessor& p) : AudioProcessorEditor(p), proc(p), web(makeOptions(p))
{
    addAndMakeVisible(web);
    web.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    setResizable(true, true);
    setResizeLimits(900, 600, 2600, 1800);
    setSize(1360, 860);
}

DrumheadEditor::~DrumheadEditor() = default;

void DrumheadEditor::paint(juce::Graphics& g) { g.fillAll(juce::Colour(0xff15171c)); }
void DrumheadEditor::resized() { web.setBounds(getLocalBounds()); }
