import React, { useEffect, useRef, useState } from 'react';
import {
  Headphones, FileUp, Type, Play, Pause, Download, Loader2,
  AlertTriangle, Volume2, Sparkles, RotateCcw, FileText, Gauge, Zap, Info,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  VOICE_OPTIONS, DEFAULT_VOICE, isGeminiConfigured, fileToBase64,
  extractReadableText, synthesizeSpeechBatch, mergeWavBlobs, chunkText, isQuotaError,
} from '../utils/gemini';

type InputMode = 'file' | 'text';
type Status = 'idle' | 'extracting' | 'synthesizing' | 'ready' | 'error';
type Engine = 'device' | 'neural';
type OutputKind = 'gemini' | 'device';

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];
const VOICE_STORAGE_KEY = 'ai_reader_voice';
const ENGINE_STORAGE_KEY = 'ai_reader_engine';
const DEVICE_TTS_AVAILABLE = typeof window !== 'undefined' && 'speechSynthesis' in window;

const PLAIN_TEXT_EXT = /\.(txt|md|markdown|csv|json|log)$/i;
function isPlainTextFile(file: File): boolean {
  return file.type.startsWith('text/') || PLAIN_TEXT_EXT.test(file.name);
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Waveform bars shown while playing.
const WAVE_DELAYS = [0, 0.3, 0.15, 0.45, 0.07, 0.37, 0.22];

interface AudioReaderProps {
  initialFile?: { base64: string; mimeType: string; name: string } | null;
  onConsumedInitialFile?: () => void;
  initialText?: string;
  onConsumedInitialText?: () => void;
}

export default function AudioReader({
  initialFile, onConsumedInitialFile,
  initialText, onConsumedInitialText,
}: AudioReaderProps) {
  const [inputMode, setInputMode] = useState<InputMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [voice, setVoice] = useState<string>(
    () => localStorage.getItem(VOICE_STORAGE_KEY) || DEFAULT_VOICE
  );
  const [engine, setEngine] = useState<Engine>(
    () => (localStorage.getItem(ENGINE_STORAGE_KEY) as Engine) || 'device'
  );

  const [status, setStatus] = useState<Status>('idle');
  const [progressLabel, setProgressLabel] = useState('');
  const [transcript, setTranscript] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [outputKind, setOutputKind] = useState<OutputKind | null>(null);
  const [sourceName, setSourceName] = useState('reading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const deviceTextRef = useRef('');

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);
  const configured = isGeminiConfigured();

  // Persist chosen voice.
  const setVoiceAndSave = (v: string) => {
    setVoice(v);
    localStorage.setItem(VOICE_STORAGE_KEY, v);
  };

  const setEngineAndSave = (e: Engine) => {
    setEngine(e);
    localStorage.setItem(ENGINE_STORAGE_KEY, e);
  };

  // --- Device voice (browser SpeechSynthesis): free, unlimited, instant ---
  const pickDeviceVoice = (): SpeechSynthesisVoice | null => {
    if (!DEVICE_TTS_AVAILABLE) return null;
    const voices = window.speechSynthesis.getVoices();
    const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
    return (
      en.find((v) => /natural|enhanced|premium|samantha|siri/i.test(v.name)) ||
      en[0] || voices[0] || null
    );
  };

  const stopDevice = () => {
    if (DEVICE_TTS_AVAILABLE) window.speechSynthesis.cancel();
    setIsPlaying(false);
  };

  const speakWithDevice = (text: string, rateArg: number = rate) => {
    if (!DEVICE_TTS_AVAILABLE) {
      setError('This browser has no built-in speech voice — try the neural voice instead.');
      setStatus('error');
      return;
    }
    window.speechSynthesis.cancel();
    deviceTextRef.current = text;
    const voiceObj = pickDeviceVoice();
    // Speak in small sentence groups so very long text doesn't trip the
    // browser's ~15s single-utterance cutoff.
    const parts = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [text];
    const groups: string[] = [];
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 220 && cur.trim()) { groups.push(cur); cur = ''; }
      cur += p;
    }
    if (cur.trim()) groups.push(cur);

    const last = groups.length - 1;
    groups.forEach((g, i) => {
      const u = new SpeechSynthesisUtterance(g.trim());
      if (voiceObj) u.voice = voiceObj;
      u.rate = rateArg;
      if (i === 0) u.onstart = () => setIsPlaying(true);
      if (i === last) u.onend = () => setIsPlaying(false);
      u.onerror = () => setIsPlaying(false);
      window.speechSynthesis.speak(u);
    });
  };

  const toggleDevicePlayback = () => {
    if (!DEVICE_TTS_AVAILABLE) return;
    const ss = window.speechSynthesis;
    if (ss.speaking && !ss.paused) { ss.pause(); setIsPlaying(false); }
    else if (ss.paused) { ss.resume(); setIsPlaying(true); }
    else { speakWithDevice(deviceTextRef.current); }
  };

  // Warm up the device voice list (populated asynchronously) and stop any
  // speech when the component unmounts.
  useEffect(() => {
    if (!DEVICE_TTS_AVAILABLE) return;
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    return () => {
      window.speechSynthesis.cancel();
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // Revoke stale object URLs to avoid memory leaks.
  useEffect(() => {
    audioUrlRef.current = audioUrl;
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [audioUrl]);

  // Auto-play whenever a new audio URL is ready (user gesture context carried
  // through from initial click, keyboard shortcut etc.).
  useEffect(() => {
    const el = audioRef.current;
    if (!audioUrl || !el) return;
    el.play().catch(() => {
      // Browser blocked autoplay (no recent gesture) — user can press play.
    });
  }, [audioUrl]);

  // Auto-generate when a document is handed in from the viewer.
  useEffect(() => {
    if (!initialFile) return;
    setInputMode('file');
    setSourceName(initialFile.name);
    void generateFromSource(
      { kind: 'doc', base64: initialFile.base64, mimeType: initialFile.mimeType },
      initialFile.name
    );
    onConsumedInitialFile?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // Auto-generate when selected text is handed in (from shortcut / popover).
  useEffect(() => {
    if (!initialText?.trim()) return;
    resetOutput();
    setInputMode('text');
    setPastedText(initialText);
    void generateFromSource({ kind: 'text', text: initialText }, 'selected text');
    onConsumedInitialText?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  const resetOutput = () => {
    setStatus('idle');
    setProgressLabel('');
    setTranscript('');
    setError('');
    setNotice('');
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    audioRef.current?.pause();
    stopDevice();
    setOutputKind(null);
    setAudioUrl(null);
  };

  type Source =
    | { kind: 'text'; text: string }
    | { kind: 'doc'; base64: string; mimeType: string };

  async function generateFromSource(source: Source, name: string) {
    // Reading a PDF/image always needs Gemini to extract its text, regardless
    // of which voice engine plays it back.
    if (source.kind === 'doc' && !configured) {
      setError('Reading a PDF or image needs the Gemini key to extract its text. Add GEMINI_API_KEY, or paste the text directly to use the free device voice.');
      setStatus('error');
      return;
    }
    if (engine === 'neural' && !configured) {
      setError('The neural voice needs GEMINI_API_KEY. Switch to the free device voice, or add the key.');
      setStatus('error');
      return;
    }
    try {
      setError('');
      setNotice('');
      setAudioUrl(null);
      setOutputKind(null);
      setSourceName(name || 'reading');

      let text: string;
      if (source.kind === 'text') {
        text = source.text.trim();
      } else {
        setStatus('extracting');
        setProgressLabel('Reading your file with Gemini…');
        text = await extractReadableText(source.base64, source.mimeType);
      }
      if (!text) throw new Error('No readable text found in this file.');
      setTranscript(text);

      // Free, unlimited, instant — the device's built-in voice.
      if (engine === 'device') {
        setOutputKind('device');
        setStatus('ready');
        setProgressLabel('');
        speakWithDevice(text);
        return;
      }

      // Premium Gemini neural voice (free tier is limited to 10 requests/day).
      try {
        const chunks = chunkText(text);
        setStatus('synthesizing');
        const blobs = await synthesizeSpeechBatch(chunks, voice, {
          onProgress: (done, total) =>
            setProgressLabel(
              total > 1 ? `Generating voice… ${done} / ${total}` : 'Generating natural voice…'
            ),
        });
        const merged = await mergeWavBlobs(blobs);
        setAudioUrl(URL.createObjectURL(merged));
        setOutputKind('gemini');
        setStatus('ready');
        setProgressLabel('');
      } catch (e) {
        // Out of Gemini quota → keep the user listening with the free voice.
        if (isQuotaError(e) && DEVICE_TTS_AVAILABLE) {
          setNotice("Gemini's free daily limit (10 requests/day) is used up. Reading with your device's built-in voice instead — free and unlimited.");
          setOutputKind('device');
          setStatus('ready');
          setProgressLabel('');
          speakWithDevice(text);
          return;
        }
        throw e;
      }
    } catch (e: any) {
      console.error('AudioReader error:', e);
      setError(
        isQuotaError(e)
          ? "Gemini's free daily limit (10 requests/day) is used up. Switch to the free Device voice above to keep listening."
          : (e?.message || 'Something went wrong while generating audio.')
      );
      setStatus('error');
      setProgressLabel('');
    }
  }

  const handleGenerate = async () => {
    resetOutput();
    if (inputMode === 'text') {
      if (!pastedText.trim()) {
        setError('Paste some text first, then generate audio.');
        setStatus('error');
        return;
      }
      await generateFromSource({ kind: 'text', text: pastedText }, 'pasted text');
      return;
    }
    if (!file) {
      setError('Choose a file to listen to first.');
      setStatus('error');
      return;
    }
    if (isPlainTextFile(file)) {
      await generateFromSource({ kind: 'text', text: await file.text() }, file.name);
    } else {
      const base64 = await fileToBase64(file);
      await generateFromSource({ kind: 'doc', base64, mimeType: file.type || 'application/pdf' }, file.name);
    }
  };

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    el.paused ? el.play() : el.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Number(e.target.value);
    setCurrentTime(el.currentTime);
  };

  const cycleRate = () => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
    // Device voice can't change rate mid-utterance — restart at the new speed.
    if (outputKind === 'device' && DEVICE_TTS_AVAILABLE && window.speechSynthesis.speaking) {
      speakWithDevice(deviceTextRef.current, next);
    }
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = `${sourceName.replace(/\.[^.]+$/, '') || 'reading'}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const busy = status === 'extracting' || status === 'synthesizing';

  return (
    <div className="bg-white border border-gray-150 rounded-2xl shadow-xs overflow-hidden">
      {/* Header */}
      <div className="p-5 sm:p-6 border-b border-gray-100 flex items-center justify-between gap-3.5">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-xs">
            <Headphones className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-950 tracking-tight flex items-center gap-2">
              AI Voice Reader
              <span className="text-[8px] font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-md px-1.5 py-0.5">
                Natural Voice
              </span>
            </h2>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">
              Listen to PDFs &amp; documents in a lifelike voice
            </p>
          </div>
        </div>

        {/* Shortcut hint */}
        <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-gray-400 bg-gray-50 border border-gray-150 rounded-xl px-3 py-2 shrink-0">
          <span>Select any text then press</span>
          <kbd className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-[10px] font-mono font-bold text-gray-700 shadow-xs">⌘⇧L</kbd>
          <span>or</span>
          <kbd className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-[10px] font-mono font-bold text-gray-700 shadow-xs">⌥L</kbd>
          <span>to listen instantly</span>
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-6">
        {!configured && (
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200/60 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800 leading-relaxed">
              <code className="font-mono">GEMINI_API_KEY</code> isn&apos;t set. Add it to{' '}
              <code className="font-mono">.env.local</code> (or the AI Studio secrets panel) and reload.
            </p>
          </div>
        )}

        {/* Input mode toggle */}
        <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl w-fit">
          {(['file', 'text'] as InputMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setInputMode(mode)}
              className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
                inputMode === mode ? 'bg-white text-gray-950 shadow-xs' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {mode === 'file' ? <FileUp className="w-3.5 h-3.5" /> : <Type className="w-3.5 h-3.5" />}
              {mode === 'file' ? 'Upload File' : 'Paste Text'}
            </button>
          ))}
        </div>

        {/* Input area */}
        {inputMode === 'file' ? (
          <label
            className={`block border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${
              file ? 'border-indigo-300 bg-indigo-50/40' : 'border-gray-200 hover:border-gray-300 bg-gray-50/40'
            }`}
          >
            <input
              type="file"
              accept=".pdf,.txt,.md,.markdown,.csv,.json,.log,image/*,application/pdf,text/plain"
              className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); resetOutput(); }}
            />
            <FileText className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            {file ? (
              <p className="text-sm font-semibold text-gray-800 truncate">{file.name}</p>
            ) : (
              <p className="text-sm font-semibold text-gray-700">Click to choose a PDF, document, or text file</p>
            )}
            <p className="text-[11px] text-gray-400 mt-1">PDF, images, .txt, .md, .csv and more</p>
          </label>
        ) : (
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="Paste the text you'd like read aloud — or select text anywhere on the page and press Command+Shift+L…"
            rows={6}
            className="w-full p-4 border border-gray-200 rounded-2xl text-sm text-gray-800 bg-gray-50/40 focus:bg-white focus:outline-none focus:ring-1 focus:ring-gray-900 focus:border-gray-900 resize-y"
          />
        )}

        {/* Voice engine */}
        <div>
          <div className="flex items-center gap-1.5 mb-2.5">
            <Volume2 className="w-3.5 h-3.5 text-gray-500" />
            <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Voice engine</h4>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setEngineAndSave('device')}
              className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                engine === 'device'
                  ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500/20'
                  : 'border-gray-150 bg-white hover:bg-gray-50 hover:border-gray-200'
              }`}
            >
              <p className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-indigo-600" /> Device voice
              </p>
              <p className="text-[10px] text-gray-450 mt-0.5 leading-snug">Free · instant · any length</p>
            </button>
            <button
              type="button"
              onClick={() => setEngineAndSave('neural')}
              className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                engine === 'neural'
                  ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500/20'
                  : 'border-gray-150 bg-white hover:bg-gray-50 hover:border-gray-200'
              }`}
            >
              <p className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-indigo-600" /> Neural voice
              </p>
              <p className="text-[10px] text-gray-450 mt-0.5 leading-snug">Lifelike · Gemini · 10/day free</p>
            </button>
          </div>
        </div>

        {/* Gemini voice picker (neural engine only) */}
        {engine === 'neural' && (
          <div>
            <div className="flex items-center gap-1.5 mb-2.5">
              <Volume2 className="w-3.5 h-3.5 text-gray-500" />
              <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Choose a Voice</h4>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {VOICE_OPTIONS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVoiceAndSave(v.id)}
                  className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                    voice === v.id
                      ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500/20'
                      : 'border-gray-150 bg-white hover:bg-gray-50 hover:border-gray-200'
                  }`}
                >
                  <p className="text-xs font-bold text-gray-900">{v.label}</p>
                  <p className="text-[10px] text-gray-450 mt-0.5 leading-snug">{v.description}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Generate button */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy || (engine === 'neural' && !configured)}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-xl transition-colors flex items-center justify-center gap-2 shadow-sm cursor-pointer"
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{progressLabel || 'Working…'}</span>
            </>
          ) : engine === 'device' ? (
            <>
              <Zap className="w-4 h-4" />
              <span>Read Aloud (free)</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>Generate Audio</span>
            </>
          )}
        </button>

        {/* Info notice (e.g. quota fallback) */}
        {notice && (
          <div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-150 flex items-start gap-2.5">
            <Info className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
            <p className="text-xs text-indigo-800 leading-relaxed">{notice}</p>
          </div>
        )}

        {/* Error */}
        {status === 'error' && error && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-150 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
            <p className="text-xs text-red-700 leading-relaxed">{error}</p>
          </div>
        )}

        {/* Device-voice player (free, browser SpeechSynthesis) */}
        {status === 'ready' && outputKind === 'device' && (
          <div className="rounded-2xl border border-gray-150 bg-gradient-to-br from-gray-50 to-white p-5 shadow-xs">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={toggleDevicePlayback}
                className="w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md shrink-0 cursor-pointer transition-colors"
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-gray-800 truncate">{sourceName}</p>
                <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5">
                  <Zap className="w-3 h-3" /> Free device voice {isPlaying ? '· playing…' : '· paused'}
                </p>
              </div>
              <button
                type="button"
                onClick={stopDevice}
                title="Stop"
                className="px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-[11px] font-bold text-gray-600 hover:bg-gray-50 cursor-pointer shrink-0"
              >
                Stop
              </button>
              <button
                type="button"
                onClick={cycleRate}
                title="Playback speed"
                className="px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-[11px] font-bold text-gray-600 hover:bg-gray-50 flex items-center gap-1 cursor-pointer shrink-0"
              >
                <Gauge className="w-3.5 h-3.5" /> {rate}×
              </button>
            </div>
          </div>
        )}

        {/* Player */}
        <AnimatePresence>
          {status === 'ready' && outputKind === 'gemini' && audioUrl && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="rounded-2xl border border-gray-150 bg-gradient-to-br from-gray-50 to-white p-5 space-y-4 shadow-xs"
            >
              <audio
                ref={audioRef}
                src={audioUrl}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration);
                  e.currentTarget.playbackRate = rate;
                }}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />

              <div className="flex items-center gap-4">
                {/* Play/Pause */}
                <button
                  type="button"
                  onClick={togglePlay}
                  className="w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md shrink-0 cursor-pointer transition-colors"
                >
                  {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                </button>

                {/* Track info + waveform */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-xs font-semibold text-gray-800 truncate">{sourceName}</p>
                    {/* Animated waveform while playing */}
                    {isPlaying && (
                      <div className="flex items-end gap-[3px] h-4 shrink-0">
                        {WAVE_DELAYS.map((delay, i) => (
                          <div
                            key={i}
                            className="w-[3px] rounded-full bg-indigo-400"
                            style={{
                              animationName: 'voice-bar',
                              animationDuration: '0.55s',
                              animationTimingFunction: 'ease-in-out',
                              animationDirection: 'alternate',
                              animationIterationCount: 'infinite',
                              animationDelay: `${delay}s`,
                              height: '3px',
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={currentTime}
                    onChange={handleSeek}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-gray-400 font-mono mt-1">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>

                {/* Speed */}
                <button
                  type="button"
                  onClick={cycleRate}
                  title="Playback speed"
                  className="px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-[11px] font-bold text-gray-600 hover:bg-gray-50 flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <Gauge className="w-3.5 h-3.5" /> {rate}×
                </button>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex-1 py-2 bg-gray-950 hover:bg-black text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Download className="w-3.5 h-3.5" /> Download (WAV)
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  className="px-3 py-2 bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                  title="Regenerate"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Redo
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Transcript */}
        {transcript && (
          <details className="rounded-xl border border-gray-150 bg-gray-50/50 p-4">
            <summary className="text-[10px] font-bold text-gray-400 uppercase tracking-widest cursor-pointer flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Transcript
            </summary>
            <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap mt-3 max-h-72 overflow-y-auto">
              {transcript}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
