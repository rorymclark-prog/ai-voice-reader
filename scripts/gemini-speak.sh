#!/bin/bash
#
# gemini-speak.sh — read selected text aloud in a Gemini neural voice.
#
# Used by the "Speak with Gemini" macOS Quick Action: the selected text is
# piped in on stdin (Automator → Run Shell Script, "Pass input: to stdin").
# Also works from the terminal:  echo "hello" | gemini-speak.sh
#
# Voice: put a voice name (e.g. Kore, Sulafat, Charon) in ~/.gemini-speak-voice
#        to change it. Defaults to Kore.
# Key:   read from the AI Voice Reader app's .env.local (single source of truth).

set -euo pipefail

notify() { osascript -e "display notification \"$1\" with title \"Speak with Gemini\"" >/dev/null 2>&1 || true; }

# --- gather the text (stdin first, then args) ---
TEXT="$(cat 2>/dev/null || true)"
if [ -z "${TEXT//[[:space:]]/}" ]; then TEXT="$*"; fi
TEXT="$(printf '%s' "$TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -z "$TEXT" ]; then notify "No text selected."; exit 0; fi

# --- config ---
ENV_FILE="/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader/.env.local"
KEY="$(grep -o 'AIza[A-Za-z0-9_-]*' "$ENV_FILE" 2>/dev/null | head -1 || true)"
if [ -z "$KEY" ]; then notify "Gemini API key not found in .env.local"; exit 1; fi
VOICE_FILE="$HOME/.gemini-speak-voice"
VOICE="Kore"
[ -f "$VOICE_FILE" ] && VOICE="$(tr -d '[:space:]' < "$VOICE_FILE")"
[ -z "$VOICE" ] && VOICE="Kore"
MODEL="gemini-2.5-flash-preview-tts"

# Stop any audio already playing (press the hotkey again to interrupt).
pkill -x afplay >/dev/null 2>&1 || true

# --- build the request body safely (handles quotes/newlines) ---
REQ_FILE="$(mktemp -t gspeak_req).json"
TEXT="$TEXT" VOICE="$VOICE" REQ_FILE="$REQ_FILE" python3 -c '
import os, json
body = {
  "contents": [{"role": "user", "parts": [
    {"text": "Read this text aloud in a natural voice. Audio only, no extra words.\n\n" + os.environ["TEXT"]}
  ]}],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": os.environ["VOICE"]}}},
  },
}
open(os.environ["REQ_FILE"], "w").write(json.dumps(body))
' || { notify "Failed to build request"; exit 1; }

RESP_FILE="$(mktemp -t gspeak_resp).json"
HTTP="$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}" \
  -H 'Content-Type: application/json' -X POST --data-binary "@${REQ_FILE}")"

if [ "$HTTP" != "200" ]; then
  MSG="$(RESP_FILE="$RESP_FILE" python3 -c 'import os,json;d=json.load(open(os.environ["RESP_FILE"]));print(d.get("error",{}).get("message","")[:140])' 2>/dev/null || true)"
  [ -z "$MSG" ] && MSG="Gemini returned HTTP $HTTP"
  notify "$MSG"
  rm -f "$REQ_FILE" "$RESP_FILE"
  exit 1
fi

# --- decode base64 PCM → WAV ---
WAV_FILE="$(mktemp -t gspeak).wav"
RESP_FILE="$RESP_FILE" WAV_FILE="$WAV_FILE" python3 -c '
import os, json, base64, struct
d = json.load(open(os.environ["RESP_FILE"]))
b64 = d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
pcm = base64.b64decode(b64)
sr, ch, bits = 24000, 1, 16
block = ch * bits // 8
hdr = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
       struct.pack("<IHHIIHH", 16, 1, ch, sr, sr * block, block, bits) +
       b"data" + struct.pack("<I", len(pcm)))
open(os.environ["WAV_FILE"], "wb").write(hdr + pcm)
' 2>/dev/null || { notify "Could not decode audio"; rm -f "$REQ_FILE" "$RESP_FILE"; exit 1; }

afplay "$WAV_FILE"
rm -f "$REQ_FILE" "$RESP_FILE" "$WAV_FILE"
