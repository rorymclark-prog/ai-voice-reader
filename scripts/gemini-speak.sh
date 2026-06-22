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

# --- gather the text (stdin → args → clipboard) ---
# Some apps (notably Adobe Acrobat) don't hand the selection to macOS Services,
# so as a last resort we read the clipboard — meaning "select, Cmd+C, hotkey"
# always works, even where the Services selection is empty.
TEXT="$(cat 2>/dev/null || true)"
if [ -z "${TEXT//[[:space:]]/}" ]; then TEXT="$*"; fi
if [ -z "${TEXT//[[:space:]]/}" ]; then TEXT="$(pbpaste 2>/dev/null || true)"; fi
TEXT="$(printf '%s' "$TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -z "$TEXT" ]; then notify "No text found. Select text (or copy it with Cmd+C) first."; exit 0; fi

# --- config ---
ENV_FILE="/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader/.env.local"
KEY="$(grep -o 'AIza[A-Za-z0-9_-]*' "$ENV_FILE" 2>/dev/null | head -1 || true)"
if [ -z "$KEY" ]; then notify "Gemini API key not found in .env.local"; exit 1; fi
VOICE_FILE="$HOME/.gemini-speak-voice"
VOICE="Kore"
[ -f "$VOICE_FILE" ] && VOICE="$(tr -d '[:space:]' < "$VOICE_FILE")"
# A one-off voice from the popup picker takes priority over the saved default.
[ -n "${GSPEAK_VOICE:-}" ] && VOICE="$GSPEAK_VOICE"
[ -z "$VOICE" ] && VOICE="Kore"
MODEL="gemini-2.5-flash-preview-tts"

# Stop any previous run before starting — an earlier press might still be
# synthesizing or playing. Without this, two voices overlap.
PIDFILE="/tmp/gemini-speak.pid"
if [ -f "$PIDFILE" ]; then
  OLDPID="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$OLDPID" ] && kill "$OLDPID" 2>/dev/null || true
fi
pkill -x afplay >/dev/null 2>&1 || true

# Hand off to the streaming player: it splits the text into sentence-sized
# chunks, synthesizes them in parallel, and plays them in order as they arrive
# — so the first words start in ~5s instead of waiting for the whole block.
PYDIR="$(cd "$(dirname "$0")" && pwd)"
printf '%s' "$TEXT" | KEY="$KEY" VOICE="$VOICE" MODEL="$MODEL" python3 "$PYDIR/gemini_speak.py" &
PYPID=$!
echo "$PYPID" > "$PIDFILE"
wait "$PYPID" 2>/dev/null || true
