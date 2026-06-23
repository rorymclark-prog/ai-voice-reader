#!/bin/bash
#
# gemini-app.sh — open the full AI Voice Reader app, starting the dev server
# first if it isn't already running. Used by the menu-bar "Open full app" item.

set -euo pipefail

APP_DIR="/Users/roryclark/Documents/Mac and Cloud Health/ai-voice-reader"
URL="http://localhost:3001"

if ! curl -s -o /dev/null --max-time 2 "$URL"; then
  # Not up yet — start it in the background, then wait for it to answer.
  ( cd "$APP_DIR" && nohup npm run dev -- --port 3001 >/tmp/gemini-app-dev.log 2>&1 & )
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 2 "$URL" && break
    sleep 0.5
  done
fi

open "$URL"
