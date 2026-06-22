#!/bin/bash
#
# gemini-open.sh — open the full AI Voice Reader app window with the selected
# text pre-loaded, so it starts generating immediately and you get the whole UI
# (voice picker, transcript, download). Paired with a Hammerspoon hotkey that
# copies the selection first.
#
# Usage:  echo "some text" | gemini-open.sh     (or it falls back to clipboard)

set -euo pipefail

APP_URL="http://localhost:3001"

TEXT="$(cat 2>/dev/null || true)"
if [ -z "${TEXT//[[:space:]]/}" ]; then TEXT="$(pbpaste 2>/dev/null || true)"; fi
TEXT="$(printf '%s' "$TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "$TEXT" ]; then
  # Nothing selected — just open the app.
  open "$APP_URL"
  exit 0
fi

# URL-encode the text and open the app with it. The app reads ?text= on load,
# fills the reader, and auto-generates.
ENC="$(TEXT="$TEXT" python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["TEXT"]))')"
open "${APP_URL}/?text=${ENC}"
