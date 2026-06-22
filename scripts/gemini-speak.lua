-- gemini-speak.lua — Mac-wide Gemini-voice hotkeys.
--
-- Works in EVERY app (Adobe, Preview, Word, browsers): Hammerspoon grabs the
-- key at the system level and copies the current selection. Your text never
-- moves — everything happens over whatever you're looking at.
--
--   ⌘⇧L  →  speak the selection inline with your default voice (quick).
--   ⌘⇧J  →  pop up a voice picker over your text; pick a voice → it reads &
--           remembers that voice as the new default.
--   ⌘⇧K  →  open the full reader window with the selection (voices, download).

local BASE  = "/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader/scripts"
local SPEAK = BASE .. "/gemini-speak.sh"
local OPEN  = BASE .. "/gemini-open.sh"
local SPEAK_TMP = "/tmp/gemini_speak_input.txt"
local OPEN_TMP  = "/tmp/gemini_open_input.txt"

-- All 30 Gemini voices (kept in sync with the app's VOICE_OPTIONS).
local VOICES = {
  { text = "Kore", subText = "Firm — great for documents" },
  { text = "Puck", subText = "Upbeat" },
  { text = "Charon", subText = "Informative" },
  { text = "Aoede", subText = "Breezy" },
  { text = "Fenrir", subText = "Excitable" },
  { text = "Leda", subText = "Youthful" },
  { text = "Zephyr", subText = "Bright" },
  { text = "Orus", subText = "Firm" },
  { text = "Callirrhoe", subText = "Easy-going" },
  { text = "Autonoe", subText = "Bright" },
  { text = "Enceladus", subText = "Breathy" },
  { text = "Iapetus", subText = "Clear" },
  { text = "Umbriel", subText = "Easy-going" },
  { text = "Algieba", subText = "Smooth" },
  { text = "Despina", subText = "Smooth" },
  { text = "Erinome", subText = "Clear" },
  { text = "Algenib", subText = "Gravelly" },
  { text = "Rasalgethi", subText = "Informative" },
  { text = "Laomedeia", subText = "Upbeat" },
  { text = "Achernar", subText = "Soft" },
  { text = "Alnilam", subText = "Firm" },
  { text = "Schedar", subText = "Even" },
  { text = "Gacrux", subText = "Mature" },
  { text = "Pulcherrima", subText = "Forward" },
  { text = "Achird", subText = "Friendly" },
  { text = "Zubenelgenubi", subText = "Casual" },
  { text = "Vindemiatrix", subText = "Gentle" },
  { text = "Sadachbia", subText = "Lively" },
  { text = "Sadaltager", subText = "Knowledgeable" },
  { text = "Sulafat", subText = "Warm" },
}

-- Copy the current selection into `tmp`, then call onReady(hasText). Your
-- clipboard is restored afterwards, so this is invisible.
local function grabSelection(tmp, onReady)
  hs.execute("/usr/bin/pkill -x afplay") -- cut any current playback right away
  local saved = hs.pasteboard.getContents()
  hs.eventtap.keyStroke({ "cmd" }, "c")

  hs.timer.doAfter(0.12, function()
    local text = hs.pasteboard.getContents()
    local hasText = text ~= nil and text:gsub("%s", "") ~= ""
    if hasText then
      local f = io.open(tmp, "w")
      if f then f:write(text); f:close() end
    end
    onReady(hasText)
    if saved ~= nil then
      hs.timer.doAfter(0.4, function() hs.pasteboard.setContents(saved) end)
    end
  end)
end

local function runScript(script, tmp, voiceEnv)
  local prefix = voiceEnv and ("GSPEAK_VOICE='" .. voiceEnv .. "' ") or ""
  hs.task.new("/bin/bash", nil, { "-c", "cat '" .. tmp .. "' | " .. prefix .. "'" .. script .. "'" }):start()
end

-- The floating voice picker (Spotlight-style overlay; text stays in place).
local voiceChooser = hs.chooser.new(function(choice)
  if not choice then return end -- dismissed with Esc
  local voice = choice.text
  -- Remember this voice as the new default so ⌘⇧L uses it too.
  local vf = io.open(os.getenv("HOME") .. "/.gemini-speak-voice", "w")
  if vf then vf:write(voice); vf:close() end
  hs.alert.show("🔊 " .. voice .. "…", 1.2)
  runScript(SPEAK, SPEAK_TMP, voice)
end)
voiceChooser:choices(VOICES)
voiceChooser:rows(8)
voiceChooser:searchSubText(true)
voiceChooser:placeholderText("Pick a Gemini voice for the selected text…")

-- ⌘⇧L — speak inline with the default voice.
hs.hotkey.bind({ "cmd", "shift" }, "L", function()
  grabSelection(SPEAK_TMP, function(hasText)
    if hasText then
      hs.alert.show("🔊 Generating…", 1.2)
      runScript(SPEAK, SPEAK_TMP)
    else
      hs.alert.show("Gemini: nothing selected")
    end
  end)
end)

-- ⌘⇧J — pop up the voice picker over the current app.
hs.hotkey.bind({ "cmd", "shift" }, "J", function()
  grabSelection(SPEAK_TMP, function(hasText)
    if hasText then
      voiceChooser:query("")
      voiceChooser:show()
    else
      hs.alert.show("Gemini: nothing selected")
    end
  end)
end)

-- ⌘⇧K — open the full reader window with the selection.
hs.hotkey.bind({ "cmd", "shift" }, "K", function()
  grabSelection(OPEN_TMP, function(hasText)
    if hasText then
      hs.alert.show("📖 Opening reader…", 1.2)
      runScript(OPEN, OPEN_TMP)
    else
      hs.alert.show("Gemini: nothing selected")
    end
  end)
end)

hs.alert.show("Gemini ready  •  ⌘⇧L speak  •  ⌘⇧J pick voice  •  ⌘⇧K window")

-- Load marker (proves this file parsed and all hotkeys bound without error).
do
  local lf = io.open("/tmp/gemini_speak_loaded", "w")
  if lf then lf:write("loaded ok"); lf:close() end
end
