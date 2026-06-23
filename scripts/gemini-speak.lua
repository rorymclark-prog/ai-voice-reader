-- gemini-speak.lua — Mac-wide Gemini-voice hotkeys.
--
-- Works in EVERY app (Adobe, Preview, Word, browsers): Hammerspoon grabs the
-- key at the system level and copies the current selection. Your text never
-- moves — everything happens over whatever you're looking at.
--
--   ⌘⇧L  →  speak the selection instantly with your default voice.
--   ⌘⇧J  →  pop up a control panel over your text: pick a voice (it reads &
--           remembers it), open the full app, or stop playback.
--   ⌘⇧K  →  open the full reader window with the selection.
--
-- NOTE: a menu-bar icon was attempted but Hammerspoon 1.1.1 cannot render
-- status items on macOS 26 (Tahoe), so the ⌘⇧J popup is the control panel.

pcall(require, "hs.ipc") -- enables the `hs` CLI for diagnostics

local BASE = "/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader/scripts"
local SPEAK = BASE .. "/gemini-speak.sh"
local OPEN = BASE .. "/gemini-open.sh"
local APP = BASE .. "/gemini-app.sh"
local SPEAK_TMP = "/tmp/gemini_speak_input.txt"
local OPEN_TMP = "/tmp/gemini_open_input.txt"

local HOME = os.getenv("HOME")
local VOICE_PREF = HOME .. "/.gemini-speak-voice"

-- All 30 Gemini voices (kept in sync with the app's VOICE_OPTIONS).
local VOICES = {
  { name = "Kore", desc = "Firm — great for documents" },
  { name = "Puck", desc = "Upbeat" },
  { name = "Charon", desc = "Informative" },
  { name = "Aoede", desc = "Breezy" },
  { name = "Fenrir", desc = "Excitable" },
  { name = "Leda", desc = "Youthful" },
  { name = "Zephyr", desc = "Bright" },
  { name = "Orus", desc = "Firm" },
  { name = "Callirrhoe", desc = "Easy-going" },
  { name = "Autonoe", desc = "Bright" },
  { name = "Enceladus", desc = "Breathy" },
  { name = "Iapetus", desc = "Clear" },
  { name = "Umbriel", desc = "Easy-going" },
  { name = "Algieba", desc = "Smooth" },
  { name = "Despina", desc = "Smooth" },
  { name = "Erinome", desc = "Clear" },
  { name = "Algenib", desc = "Gravelly" },
  { name = "Rasalgethi", desc = "Informative" },
  { name = "Laomedeia", desc = "Upbeat" },
  { name = "Achernar", desc = "Soft" },
  { name = "Alnilam", desc = "Firm" },
  { name = "Schedar", desc = "Even" },
  { name = "Gacrux", desc = "Mature" },
  { name = "Pulcherrima", desc = "Forward" },
  { name = "Achird", desc = "Friendly" },
  { name = "Zubenelgenubi", desc = "Casual" },
  { name = "Vindemiatrix", desc = "Gentle" },
  { name = "Sadachbia", desc = "Lively" },
  { name = "Sadaltager", desc = "Knowledgeable" },
  { name = "Sulafat", desc = "Warm" },
}

local function currentVoice()
  local f = io.open(VOICE_PREF, "r")
  if f then
    local v = f:read("*l"); f:close()
    if v and v ~= "" then return (v:gsub("%s", "")) end
  end
  return "Kore"
end

local function setVoice(v)
  local f = io.open(VOICE_PREF, "w")
  if f then f:write(v); f:close() end
end

-- Copy the current selection into `tmp`, then call onReady(hasText). The
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

local function openApp()
  hs.task.new("/bin/bash", nil, { "-lc", "'" .. APP .. "'" }):start()
end

-- ── ⌘⇧J control panel (Spotlight-style popup over the current app) ──────────
-- Whether the press had a text selection — decides if a chosen voice also reads.
local panelHasText = false

local function panelChoices()
  local cur = currentVoice()
  local items = {
    { text = "🖥  Open full app (paste / upload)", subText = "Full window: paste box, transcript, download", kind = "app" },
    { text = "⏹  Stop playback", subText = "Stop the current voice", kind = "stop" },
  }
  for _, v in ipairs(VOICES) do
    items[#items + 1] = {
      text = v.name,
      subText = v.desc .. (v.name == cur and "   ✓ current default" or ""),
      kind = "voice",
    }
  end
  return items
end

local panel = hs.chooser.new(function(choice)
  if not choice then return end
  if choice.kind == "app" then
    openApp()
    return
  elseif choice.kind == "stop" then
    hs.execute("/usr/bin/pkill -x afplay")
    return
  end
  -- a voice was chosen: remember it as the default…
  setVoice(choice.text)
  -- …and read the selection now, if there was one.
  if panelHasText then
    hs.alert.show("🔊 " .. choice.text .. "…", 1.2)
    runScript(SPEAK, SPEAK_TMP, choice.text)
  else
    hs.alert.show("Default voice set: " .. choice.text, 1.2)
  end
end)
panel:choices(panelChoices)
panel:rows(9)
panel:searchSubText(true)
panel:placeholderText("Pick a voice (reads your selection) · or open the app…")

-- ── Hotkeys ────────────────────────────────────────────────────────────────
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

hs.hotkey.bind({ "cmd", "shift" }, "J", function()
  grabSelection(SPEAK_TMP, function(hasText)
    panelHasText = hasText
    panel:choices(panelChoices) -- refresh so the ✓ tracks the current default
    panel:query("")
    panel:show()
  end)
end)

hs.hotkey.bind({ "cmd", "shift" }, "K", function()
  grabSelection(OPEN_TMP, function(hasText)
    hs.alert.show("📖 Opening reader…", 1.2)
    runScript(OPEN, OPEN_TMP)
  end)
end)

hs.alert.show("Gemini ready  •  ⌘⇧L speak  •  ⌘⇧J panel  •  ⌘⇧K window")

-- Load marker (proves this file parsed and all hotkeys bound without error).
do
  local lf = io.open("/tmp/gemini_speak_loaded", "w")
  if lf then lf:write("loaded ok"); lf:close() end
end
