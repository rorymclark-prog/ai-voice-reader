/**
 * Gemini helpers for the AI Voice Reader.
 *
 * Two capabilities:
 *  1. extractReadableText  - turn a PDF / image / document into clean, spoken-readable prose.
 *  2. synthesizeSpeech     - render text to natural-sounding audio using Gemini's TTS voices.
 *
 * The Gemini TTS models return raw 16-bit PCM (mono, 24 kHz). Browsers can't play
 * bare PCM, so we wrap it in a minimal WAV container before handing back a blob URL.
 */

import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY || '';

const TEXT_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// Gemini TTS output format (documented): mono, signed 16-bit little-endian PCM @ 24 kHz.
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const TTS_BITS_PER_SAMPLE = 16;

export interface VoiceOption {
  id: string;
  label: string;
  description: string;
}

/** A curated subset of Gemini's prebuilt voices, with human-friendly descriptions. */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'Kore', label: 'Kore', description: 'Warm & firm — great for documents' },
  { id: 'Puck', label: 'Puck', description: 'Upbeat and friendly' },
  { id: 'Charon', label: 'Charon', description: 'Deep and informative' },
  { id: 'Aoede', label: 'Aoede', description: 'Breezy and light' },
  { id: 'Fenrir', label: 'Fenrir', description: 'Energetic, excitable' },
  { id: 'Leda', label: 'Leda', description: 'Youthful and clear' },
  { id: 'Zephyr', label: 'Zephyr', description: 'Bright and crisp' },
];

export const DEFAULT_VOICE = 'Kore';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!API_KEY) {
    throw new Error(
      'Gemini API key is not configured. Set GEMINI_API_KEY so the AI voice reader can run.'
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: API_KEY });
  }
  return client;
}

export function isGeminiConfigured(): boolean {
  return Boolean(API_KEY);
}

/** Strip a data URL prefix (e.g. "data:application/pdf;base64,") down to raw base64. */
function toRawBase64(data: string): string {
  const comma = data.indexOf(',');
  return data.startsWith('data:') && comma !== -1 ? data.slice(comma + 1) : data;
}

/**
 * Read a File/Blob as raw base64 (no data-URL prefix).
 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(toRawBase64(String(reader.result)));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Use Gemini's multimodal understanding to pull clean, listenable text out of a
 * document (PDF, scanned image, etc). The result is optimised for being read
 * aloud: no page furniture, headers/footers, or layout noise.
 */
export async function extractReadableText(
  base64Data: string,
  mimeType: string
): Promise<string> {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: toRawBase64(base64Data) } },
          {
            text:
              'Extract the readable content of this document as clean prose meant to be ' +
              'listened to as audio. Preserve the natural reading order and meaning. ' +
              'Expand obvious abbreviations, read numbers and dates naturally, and skip ' +
              'page numbers, repeated headers/footers, and layout artifacts. Do not add ' +
              'commentary, summaries, or headings of your own — return only the spoken text.',
          },
        ],
      },
    ],
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error('Could not extract any readable text from this file.');
  }
  return text;
}

/** Wrap raw PCM bytes in a 44-byte WAV header so browsers can play it. */
function pcmToWav(pcm: Uint8Array): Blob {
  const blockAlign = (TTS_CHANNELS * TTS_BITS_PER_SAMPLE) / 8;
  const byteRate = TTS_SAMPLE_RATE * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, TTS_CHANNELS, true);
  view.setUint32(24, TTS_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, TTS_BITS_PER_SAMPLE, true);
  writeString(36, 'data');
  view.setUint32(40, pcm.length, true);

  new Uint8Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Synthesize a chunk of text into a playable WAV Blob using a natural Gemini voice.
 * Keep chunks reasonably sized (a few thousand characters) for snappy playback.
 */
export async function synthesizeSpeech(
  text: string,
  voice: string = DEFAULT_VOICE
): Promise<Blob> {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Read the following transcript aloud in a natural voice. ' +
              'Return audio only, with no written response.\n\nTranscript:\n' +
              text,
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const audioBase64 =
    response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioBase64) {
    throw new Error('The voice model did not return any audio. Please try again.');
  }

  return pcmToWav(base64ToBytes(audioBase64));
}

/** True for "you're out of quota / rate limited" responses from Gemini. */
export function isQuotaError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message || e);
  return /\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded your current quota/i.test(msg);
}

/**
 * Retry a single TTS call on retryable errors. With billing enabled, a 429 is
 * almost always a short-lived per-minute burst limit, so we back off and retry
 * (1s, 3s, 6s) rather than giving up. If it still fails after all attempts the
 * error propagates and the caller can fall back to the free device voice.
 */
async function synthesizeWithRetry(
  text: string,
  voice: string,
  attempts = 4
): Promise<Blob> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await synthesizeSpeech(text, voice);
    } catch (e) {
      lastErr = e;
      const msg = String((e as { message?: string })?.message || e);
      const retryable =
        isQuotaError(e) ||
        /\b503\b|overloaded|unavailable|temporarily|timeout|network|fetch failed|ECONN/i.test(msg);
      if (!retryable || attempt === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, [1000, 3000, 6000][attempt] ?? 6000));
    }
  }
  throw lastErr;
}

/**
 * Synthesize many chunks with bounded concurrency while preserving order.
 *
 * Long documents used to render one chunk at a time (≈ chunks × perCallTime).
 * Running a few in flight at once cuts wall-clock to ≈ ceil(chunks / concurrency)
 * × perCallTime, so a 12-chunk file is ~3–4× faster. Concurrency is kept modest
 * and each call retries on rate-limit errors so big jobs stay reliable.
 *
 * @param onProgress called as chunks finish (out of order) with (done, total).
 */
export async function synthesizeSpeechBatch(
  chunks: string[],
  voice: string = DEFAULT_VOICE,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<Blob[]> {
  const total = chunks.length;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, total));
  const results = new Array<Blob>(total);
  let nextIndex = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= total) return;
      results[i] = await synthesizeWithRetry(chunks[i], voice);
      done += 1;
      opts.onProgress?.(done, total);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Concatenate several WAV blobs (all produced by synthesizeSpeech, so same format)
 * into a single downloadable WAV by stripping the 44-byte header off each and
 * re-wrapping the combined PCM.
 */
export async function mergeWavBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 1) return blobs[0];
  const pcmParts: Uint8Array[] = [];
  let total = 0;
  for (const blob of blobs) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pcm = bytes.subarray(44); // drop WAV header
    pcmParts.push(pcm);
    total += pcm.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of pcmParts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return pcmToWav(merged);
}

/**
 * Split long text into TTS-friendly chunks without cutting mid-sentence where
 * possible. Splits on paragraph/sentence boundaries, falling back to hard slices
 * for pathological inputs.
 */
export function chunkText(text: string, maxChars = 2400): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  // Break into sentence-ish units first.
  const units = clean.match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [clean];
  const chunks: string[] = [];
  let current = '';

  for (const unit of units) {
    if (current.length + unit.length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    if (unit.length > maxChars) {
      // A single very long unit: hard-slice it.
      for (let i = 0; i < unit.length; i += maxChars) {
        chunks.push(unit.slice(i, i + maxChars).trim());
      }
    } else {
      current += unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
