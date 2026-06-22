-- gemini-speak.lua — Mac-wide Gemini-voice hotkeys.
--
-- Works in EVERY app (Adobe, Preview, Word, browsers): Hammerspoon grabs the
-- key at the system level, copies the current selection, and hands it off.
--
--   ⌘⇧L  →  speak the selection inline (quick). Press again to restart/stop.
--   ⌘⇧K  →  open the full reader window with the selection, generating at once.

local BASE  = "/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader/scripts"
local SPEAK = BASE .. "/gemini-speak.sh"
local OPEN  = BASE .. "/gemini-open.sh"

-- Copy the current selection, then pipe it to `script`. `note` shows instantly
-- so there's immediate feedback even though Gemini takes a couple of seconds.
local function withSelection(script, tmp, note)
  hs.execute("/usr/bin/pkill -x afplay") -- cut any current playback right away
  local saved = hs.pasteboard.getContents()
  hs.eventtap.keyStroke({ "cmd" }, "c")  -- copy whatever is selected

  hs.timer.doAfter(0.12, function()
    local text = hs.pasteboard.getContents()
    if text and text:gsub("%s", "") ~= "" then
      local f = io.open(tmp, "w")
      if f then
        f:write(text)
        f:close()
        if note then hs.alert.show(note, 1.2) end
        hs.task.new("/bin/bash", nil, { "-c", "cat '" .. tmp .. "' | '" .. script .. "'" }):start()
      end
    else
      hs.alert.show("Gemini: nothing selected")
    end
    -- Put the clipboard back the way it was.
    if saved ~= nil then
      hs.timer.doAfter(0.4, function() hs.pasteboard.setContents(saved) end)
    end
  end)
end

hs.hotkey.bind({ "cmd", "shift" }, "L", function()
  withSelection(SPEAK, "/tmp/gemini_speak_input.txt", "🔊 Generating…")
end)

hs.hotkey.bind({ "cmd", "shift" }, "K", function()
  withSelection(OPEN, "/tmp/gemini_open_input.txt", "📖 Opening reader…")
end)

hs.alert.show("Gemini ready  •  ⌘⇧L speak  •  ⌘⇧K window")

-- Load marker (proves this file parsed and the hotkeys bound without error).
do
  local lf = io.open("/tmp/gemini_speak_loaded", "w")
  if lf then lf:write("loaded ok"); lf:close() end
end
