cmake_minimum_required(VERSION 3.22)
project(DrumheadLab VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(DH_BUILD_PLUGIN "Build the JUCE plugin (needs JUCE)" ON)
option(DH_BUILD_TOOLS "Build command-line render/test tools" ON)

# ---------------------------------------------------------------------------
# Sound engine: plain C++17, no JUCE, so it can be tested headless and
# compared sample-for-sample against the browser prototype (reference/).
# ---------------------------------------------------------------------------
file(GLOB DH_CORE_SOURCES CONFIGURE_DEPENDS src/core/*.cpp)
add_library(dhcore STATIC ${DH_CORE_SOURCES})
set_target_properties(dhcore PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(dhcore PUBLIC src/core)
if(MSVC)
  target_compile_options(dhcore PRIVATE /O2 /fp:precise)
else()
  target_compile_options(dhcore PRIVATE -O2)
endif()

if(DH_BUILD_TOOLS)
  add_executable(dhrender tools/dhrender.cpp)
  target_link_libraries(dhrender PRIVATE dhcore)
endif()

# ---------------------------------------------------------------------------
# Plugin (VST3 + Standalone)
# ---------------------------------------------------------------------------
if(DH_BUILD_PLUGIN)
  include(FetchContent)
  FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.4
    GIT_SHALLOW ON)
  FetchContent_MakeAvailable(JUCE)

  juce_add_plugin(DrumheadLab
    COMPANY_NAME "Drumhead Lab"
    PLUGIN_MANUFACTURER_CODE Dhlb
    PLUGIN_CODE Dhl1
    PRODUCT_NAME "Drumhead Lab"
    FORMATS VST3 Standalone
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Instrument Drum)

  juce_add_binary_data(DrumheadData SOURCES reference/kits.json reference/presets.json)
  set_target_properties(DrumheadData PROPERTIES POSITION_INDEPENDENT_CODE ON)

  target_sources(DrumheadLab PRIVATE
    src/plugin/PluginProcessor.cpp
    src/plugin/PluginEditor.cpp)

  target_compile_definitions(DrumheadLab PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=1)

  target_link_libraries(DrumheadLab
    PRIVATE dhcore DrumheadData juce::juce_audio_utils juce::juce_dsp
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_lto_flags juce::juce_recommended_warning_flags)
endif()
