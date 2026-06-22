#!/usr/bin/env python3
"""
Chunked, streaming Gemini TTS player.

The Gemini TTS preview model's latency scales hard with text length (one
sentence ~5s, a paragraph ~20-40s). So instead of one slow call, we split the
text into sentence-sized chunks, synthesize them in parallel, and play them in
order as soon as each is ready — first audio in ~5s, the rest overlap.

Reads text on stdin. Config via env: KEY, VOICE, MODEL.
"""
import os
import sys
import json
import time
import base64
import struct
import signal
import tempfile
import threading
import subprocess
import urllib.request
import urllib.error
import re

KEY = os.environ.get("KEY", "")
VOICE = os.environ.get("VOICE", "Kore")
MODEL = os.environ.get("MODEL", "gemini-2.5-flash-preview-tts")
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={KEY}"
MAX_CONCURRENCY = 4
CHUNK_LIMIT = 100  # chars — ~one sentence per chunk, so the first plays fast


def notify(msg):
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{msg[:140]}" with title "Speak with Gemini"'],
            check=False,
        )
    except Exception:
        pass


def chunk_text(t, limit=CHUNK_LIMIT):
    """Split into sentence-ish pieces, each <= limit chars where possible."""
    parts = re.findall(r"[^.!?\n]+[.!?]*\s*|\n+", t) or [t]
    chunks, cur = [], ""
    for p in parts:
        if len(cur) + len(p) > limit and cur.strip():
            chunks.append(cur.strip())
            cur = ""
        if len(p) > limit:
            for i in range(0, len(p), limit):
                piece = p[i:i + limit].strip()
                if piece:
                    chunks.append(piece)
        else:
            cur += p
    if cur.strip():
        chunks.append(cur.strip())
    return [c for c in chunks if c]


def synth(text):
    """One chunk → PCM bytes, retrying transient errors."""
    body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}},
        },
    }).encode()
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                URL, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.load(r)
            b64 = d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            return base64.b64decode(b64)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(1.2 * (attempt + 1))
                continue
            raise
        except Exception as e:  # noqa: BLE001 — transient network etc.
            last = e
            if attempt < 3:
                time.sleep(1.2 * (attempt + 1))
                continue
            raise
    if last:
        raise last


def pcm_to_wav(pcm):
    sr, ch, bits = 24000, 1, 16
    block = ch * bits // 8
    hdr = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
           struct.pack("<IHHIIHH", 16, 1, ch, sr, sr * block, block, bits) +
           b"data" + struct.pack("<I", len(pcm)))
    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="gspeak_")
    f.write(hdr + pcm)
    f.close()
    return f.name


def main():
    text = sys.stdin.read().strip()
    if not text:
        return

    chunks = chunk_text(text)
    n = len(chunks)
    wavs = [None] * n
    errors = [None] * n
    done = [threading.Event() for _ in range(n)]
    sem = threading.Semaphore(MAX_CONCURRENCY)

    def worker(i):
        with sem:
            try:
                wavs[i] = pcm_to_wav(synth(chunks[i]))
            except Exception as e:  # noqa: BLE001
                errors[i] = e
            finally:
                done[i].set()

    for i in range(n):
        threading.Thread(target=worker, args=(i,), daemon=True).start()

    # Allow the bash parent to stop us cleanly (kills the current afplay).
    current = {"proc": None}

    def stop(_sig=None, _frm=None):
        p = current["proc"]
        if p and p.poll() is None:
            p.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    played = False
    for i in range(n):
        done[i].wait()
        if errors[i] is not None:
            if not played and i == 0:
                msg = str(getattr(errors[i], "reason", errors[i]))
                notify(f"Gemini error: {msg}")
            continue
        proc = subprocess.Popen(["afplay", wavs[i]])
        current["proc"] = proc
        proc.wait()
        played = True
        try:
            os.unlink(wavs[i])
        except OSError:
            pass


if __name__ == "__main__":
    main()
