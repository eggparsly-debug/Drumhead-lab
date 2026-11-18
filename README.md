# Drumhead Lab

Physical-modelling drum, cymbal and tuned-percussion builder: a VST3 instrument for Cakewalk (Windows), ported from the browser prototype.

## Getting the plugin

Every push builds automatically on GitHub Actions. Open the **Actions** tab, pick the latest green run, and download **DrumheadLab-VST3-Windows**. Unzip it and copy `Drumhead Lab.vst3` into `C:\Program Files\Common Files\VST3\`, then rescan plugins in Cakewalk.

## Layout

| Path | What |
|---|---|
| `src/core/` | Sound engine, plain C++17 (no JUCE), real-time safe |
| `src/plugin/` | JUCE VST3 / Standalone wrapper and UI |
| `tools/dhrender.cpp` | Headless renderer and self-test |
| `reference/` | Browser prototype (`engine.js`, `presets.js`, `kits.js`, `drumhead-lab.html`) and the golden Studio kit render (`studio_kit_groove.wav`, made by `groove.js`) |

## Port plan

1. Port the engine; `dhrender --groove` must match `reference/studio_kit_groove.wav`.
2. Basic VST3 that plays the Studio kit from MIDI.
3. MIDI features: GM map with re-assignable notes and MIDI learn; any CC assignable to hi-hat pedal, strike position or choke per piece; pitch-bend tuning; velocity curve; chromatic real-pitch mapping for tuned instruments; stereo + per-piece multi-outs; preset files shared with the browser tool; kit and single-instrument modes; quality switch and voice limits.
4. Full builder UI.

## Building locally

```
cmake -S . -B build
cmake --build build --config Release
```

Licensing: personal use under JUCE's free personal tier.
