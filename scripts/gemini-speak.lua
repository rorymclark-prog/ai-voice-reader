-- gemini-speak.lua — Mac-wide "speak the selection with a Gemini voice" hotkey.
--
-- Hotkey: Cmd+Shift+L. Works in EVERY app (Adobe, Preview, Word, browsers)
-- because Hammerspoon grabs the key at the system level, then copies the
-- current selection and pipes it to gemini-speak.sh. Press again to stop.

local GEMINI_SPEAK = "/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader/scripts/gemini-speak.sh"
local TMP_INPUT = "/tmp/gemini_speak_input.txt"

hs.hotkey.bind({ "cmd", "shift" }, "L", function()
  -- Pressing again while audio plays should stop it.
  hs.execute("/usr/bin/pkill -x afplay")

  local saved = hs.pasteboard.getContents()
  hs.eventtap.keyStroke({ "cmd" }, "c") -- copy whatever is selected

  hs.timer.doAfter(0.18, function()
    local text = hs.pasteboard.getContents()
    if text and text:gsub("%s", "") ~= "" then
      local f = io.open(TMP_INPUT, "w")
      if f then
        f:write(text)
        f:close()
        hs.task.new("/bin/bash", nil, { "-c", "cat '" .. TMP_INPUT .. "' | '" .. GEMINI_SPEAK .. "'" }):start()
      end
    else
      hs.alert.show("Gemini: nothing selected")
    end
    -- Put the clipboard back the way it was.
    if saved ~= nil then
      hs.timer.doAfter(0.4, function() hs.pasteboard.setContents(saved) end)
    end
  end)
end)

hs.alert.show("Gemini Speak ready  •  ⌘⇧L")

-- Load marker (proves this file parsed and the hotkey bound without error).
do
  local lf = io.open("/tmp/gemini_speak_loaded", "w")
  if lf then lf:write("loaded ok"); lf:close() end
end
