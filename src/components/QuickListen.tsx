import React, { useEffect, useRef, useState } from 'react';
import {
  Headphones, X, Play, Pause, Loader2, Sparkles, FileUp,
  AlertTriangle, Download, FileText,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  VOICE_OPTIONS, DEFAULT_VOICE, isGeminiConfigured, fileToBase64,
  extractReadableText, synthesizeSpeech, mergeWavBlobs, chunkText,
} from '../utils/gemini';

const VOICE_STORAGE_KEY = 'ai_reader_voice';
const PLAIN_TEXT_EXT = /\.(txt|md|markdown|csv|json|log)$/i;
type Status = 'idle' | 'working' | 'ready' | 'error';

// Plain Command+L is reserved by browsers for the address bar, so Mac gets a
// nearby app-safe shortcut while Option+L stays supported.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const SHORTCUT_LABEL = IS_MAC ? '⌘⇧L' : 'Alt+L';
const FALLBACK_SHORTCUT_LABEL = IS_MAC ? '⌥L' : '';

interface Bubble { x: number; y: number; text: string; }

type AudioContextConstructor = typeof AudioContext;

function getSelectedText(): string {
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && typeof active.value === 'string')
  ) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return start === end ? '' : active.value.slice(start, end).trim();
  }
  return window.getSelection()?.toString().trim() || '';
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  return window.AudioContext || (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

/**
 * Global "Quick Listen" experience:
 *  - Press the shortcut anywhere with selected text, and reading starts automatically.
 *  - A floating bubble also appears when you select a chunk of text.
 *  - Inside the popup: edit/confirm text or choose a file, pick a voice, listen instantly.
 */
export default function QuickListen() {
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [voice, setVoice] = useState<string>(
    () => localStorage.getItem(VOICE_STORAGE_KEY) || DEFAULT_VOICE
  );

  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [instantSpeechText, setInstantSpeechText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const configured = isGeminiConfigured();

  const unlockAudioPlayback = () => {
    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass) return;
    if (!audioContextRef.current) audioContextRef.current = new AudioContextClass();
    void audioContextRef.current.resume();
  };

  const stopFallbackPlayback = () => {
    if (!activeSourceRef.current) return;
    activeSourceRef.current.onended = null;
    activeSourceRef.current.stop();
    activeSourceRef.current = null;
    setIsPlaying(false);
  };

  const stopInstantSpeech = () => {
    if (!speechUtteranceRef.current) return;
    speechUtteranceRef.current.onend = null;
    speechUtteranceRef.current.onerror = null;
    window.speechSynthesis.cancel();
    speechUtteranceRef.current = null;
    setIsPlaying(false);
  };

  const speakInstantly = (source: string) => {
    const clean = source.trim();
    if (!clean) return;
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      void run(async () => clean, true);
      return;
    }

    stopInstantSpeech();
    stopFallbackPlayback();
    audioRef.current?.pause();
    setError('');
    setAudioUrl(null);
    setInstantSpeechText(clean);
    setStatus('ready');
    setProgress('');

    const utterance = new SpeechSynthesisUtterance(clean);
    let didStart = false;
    let didFallback = false;
    const fallbackToGemini = () => {
      if (didFallback) return;
      didFallback = true;
      speechUtteranceRef.current = null;
      setIsPlaying(false);
      void run(async () => clean, true);
    };
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onstart = () => {
      didStart = true;
      setIsPlaying(true);
    };
    utterance.onend = () => {
      if (speechUtteranceRef.current === utterance) {
        speechUtteranceRef.current = null;
        setIsPlaying(false);
        if (!didStart) fallbackToGemini();
      }
    };
    utterance.onerror = () => {
      if (speechUtteranceRef.current === utterance) {
        fallbackToGemini();
      }
    };
    speechUtteranceRef.current = utterance;
    setIsPlaying(true);
    window.speechSynthesis.speak(utterance);
    window.setTimeout(() => {
      if (
        speechUtteranceRef.current === utterance &&
        !window.speechSynthesis.speaking &&
        !window.speechSynthesis.pending
      ) {
        fallbackToGemini();
      }
    }, 500);
  };

  const playWithUnlockedAudio = async (url: string) => {
    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass) throw new Error('Audio playback is not supported in this browser.');
    const ctx = audioContextRef.current || new AudioContextClass();
    audioContextRef.current = ctx;
    await ctx.resume();
    const bytes = await fetch(url).then((response) => response.arrayBuffer());
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    stopFallbackPlayback();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (activeSourceRef.current === source) {
        activeSourceRef.current = null;
        setIsPlaying(false);
      }
    };
    activeSourceRef.current = source;
    setIsPlaying(true);
    source.start();
  };

  // --- open helpers ---
  const openWith = (initialText: string, autoStart = false) => {
    dismissBubble();
    setError('');
    setStatus('idle');
    setAudioUrl(null);
    setInstantSpeechText('');
    stopInstantSpeech();
    setFileName('');
    setText(initialText);
    setOpen(true);
    if (autoStart && initialText.trim()) {
      speakInstantly(initialText);
    }
  };

  const dismissBubble = () => {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    setBubble(null);
  };

  // --- global listeners: shortcut + selection bubble ---
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Match the physical "L" key so Option+L still triggers reliably even
      // when the keyboard layout remaps e.key.
      const isL = e.code === 'KeyL' || e.key.toLowerCase() === 'l';
      const isShortcut = isL && (
        e.altKey ||
        (IS_MAC && e.metaKey && e.shiftKey) ||
        (!IS_MAC && e.ctrlKey && e.shiftKey)
      );
      if (isShortcut) {
        e.preventDefault();
        const sel = getSelectedText();
        openWith(sel, Boolean(sel));
      }
      if (e.key === 'Escape') setOpen(false);
    };

    const onMouseUp = () => {
      if (open) return; // don't pop the bubble while the modal is up
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
      setTimeout(() => {
        const sel = window.getSelection();
        const t = getSelectedText();
        if (!t || t.length < 10) { setBubble(null); return; }
        try {
          const rect = sel!.getRangeAt(0).getBoundingClientRect();
          setBubble({ x: rect.left + rect.width / 2, y: rect.top + window.scrollY - 48, text: t });
          bubbleTimer.current = setTimeout(() => setBubble(null), 5000);
        } catch { setBubble(null); }
      }, 60);
    };

    const onContextMenu = (e: MouseEvent) => {
      const t = getSelectedText();
      if (!t || t.length < 3) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, text: t });
    };

    const onClickOutside = () => setContextMenu(null);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('click', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('click', onClickOutside);
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Revoke stale object URLs.
  useEffect(() => {
    audioUrlRef.current = audioUrl;
    return () => { if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); };
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      stopInstantSpeech();
      stopFallbackPlayback();
      void audioContextRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-play when audio becomes ready.
  useEffect(() => {
    if (!audioUrl) return;
    const shouldAutoPlay = shouldAutoPlayRef.current;
    shouldAutoPlayRef.current = false;

    const playWhenMounted = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const el = audioRef.current;
      if (!el) {
        if (shouldAutoPlay) await playWithUnlockedAudio(audioUrl);
        return;
      }

      try {
        await el.play();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
        if (shouldAutoPlay && el.paused) await playWithUnlockedAudio(audioUrl);
      } catch {
        if (shouldAutoPlay) await playWithUnlockedAudio(audioUrl);
      }
    };

    void playWhenMounted().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  const setVoiceAndSave = (v: string) => {
    setVoice(v);
    localStorage.setItem(VOICE_STORAGE_KEY, v);
  };

  // --- generation ---
  async function run(getText: () => Promise<string>, autoPlayWhenReady = false) {
    if (!configured) {
      setError('Gemini API key is not configured.');
      setStatus('error');
      return;
    }
    try {
      setError('');
      setAudioUrl(null);
      setInstantSpeechText('');
      stopInstantSpeech();
      shouldAutoPlayRef.current = autoPlayWhenReady;
      setStatus('working');
      setProgress('Preparing…');
      const source = (await getText()).trim();
      if (!source) throw new Error('Nothing to read — add some text or choose a file.');
      setText(source);

      const chunks = chunkText(source);
      const blobs: Blob[] = [];
      for (let i = 0; i < chunks.length; i++) {
        setProgress(chunks.length > 1 ? `Generating voice… ${i + 1} / ${chunks.length}` : 'Generating natural voice…');
        blobs.push(await synthesizeSpeech(chunks[i], voice));
      }
      const merged = await mergeWavBlobs(blobs);
      setAudioUrl(URL.createObjectURL(merged));
      setStatus('ready');
      setProgress('');
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
      setStatus('error');
    }
  }

  const handleListen = () => {
    unlockAudioPlayback();
    void run(async () => text, true);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    unlockAudioPlayback();
    setFileName(file.name);
    await run(async () => {
      if (file.type.startsWith('text/') || PLAIN_TEXT_EXT.test(file.name)) {
        return file.text();
      }
      setProgress('Reading your file with Gemini…');
      const base64 = await fileToBase64(file);
      return extractReadableText(base64, file.type || 'application/pdf');
    }, true);
  };

  const togglePlay = () => {
    if (instantSpeechText && !audioUrl) {
      if (window.speechSynthesis.speaking) {
        stopInstantSpeech();
      } else {
        speakInstantly(instantSpeechText);
      }
      return;
    }
    if (activeSourceRef.current) {
      stopFallbackPlayback();
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    el.paused ? el.play() : el.pause();
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = `${(fileName || 'reading').replace(/\.[^.]+$/, '')}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const busy = status === 'working';

  return (
    <>
      {/* Right-click context menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: Math.max(0, Math.min(contextMenu.x, window.innerWidth - 180)),
            top: Math.max(0, Math.min(contextMenu.y, window.innerHeight - 60)),
            zIndex: 99999,
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="min-w-[160px] rounded-xl shadow-2xl overflow-hidden border border-gray-800 bg-gray-950 text-white py-1"
        >
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium hover:bg-indigo-600 transition-colors cursor-pointer"
            onMouseDown={(e) => {
              e.preventDefault();
              setContextMenu(null);
              openWith(contextMenu.text, true);
            }}
          >
            <Headphones className="w-4 h-4 shrink-0" />
            Read Aloud
          </button>
        </div>
      )}

      {/* Floating selection bubble */}
      {bubble && !open && (
        <div
          style={{ position: 'absolute', left: bubble.x, top: bubble.y, transform: 'translateX(-50%)', zIndex: 99998 }}
          onMouseDown={(e) => { e.preventDefault(); openWith(bubble.text, true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-2xl cursor-pointer bg-gray-950 text-white text-[11px] font-bold uppercase tracking-wider hover:bg-indigo-600 transition-colors select-none"
        >
          <Headphones className="w-3.5 h-3.5 shrink-0" />
          Listen <span className="opacity-50 font-normal normal-case tracking-normal ml-0.5">{SHORTCUT_LABEL}</span>
        </div>
      )}

      {/* Quick Listen modal */}
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 bg-slate-950/70 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
                    <Headphones className="w-4.5 h-4.5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-gray-950">Quick Listen</h3>
                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Natural AI voice</p>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-50 cursor-pointer">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 space-y-4 overflow-y-auto">
                {!configured && (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200/60 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-800">GEMINI_API_KEY isn&apos;t set, so audio can&apos;t be generated yet.</p>
                  </div>
                )}

                {/* Text to read */}
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Text to read</label>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={`Highlight text and press ${SHORTCUT_LABEL}${FALLBACK_SHORTCUT_LABEL ? ` or ${FALLBACK_SHORTCUT_LABEL}` : ''} — or type/paste here, or choose a file below.`}
                    rows={4}
                    className="mt-1.5 w-full p-3 border border-gray-200 rounded-xl text-sm text-gray-800 bg-gray-50/40 focus:bg-white focus:outline-none focus:ring-1 focus:ring-gray-900 focus:border-gray-900 resize-y"
                  />
                  <label className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:text-indigo-700 cursor-pointer">
                    <FileUp className="w-3.5 h-3.5" />
                    {fileName ? `File: ${fileName}` : 'Or choose a PDF / document / text file'}
                    <input
                      type="file"
                      accept=".pdf,.txt,.md,.markdown,.csv,.json,.log,image/*,application/pdf,text/plain"
                      className="hidden"
                      onChange={(e) => handleFile(e.target.files?.[0])}
                    />
                  </label>
                </div>

                {/* Voice picker */}
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Voice</label>
                  <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {VOICE_OPTIONS.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setVoiceAndSave(v.id)}
                        className={`text-left px-2.5 py-2 rounded-lg border text-xs transition-all cursor-pointer ${
                          voice === v.id
                            ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500/20'
                            : 'border-gray-150 bg-white hover:bg-gray-50'
                        }`}
                      >
                        <span className="font-bold text-gray-900">{v.label}</span>
                        <span className="block text-[9px] text-gray-400 leading-tight mt-0.5">{v.description}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Listen button */}
                <button
                  type="button"
                  onClick={handleListen}
                  disabled={busy || !configured}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  {busy ? <><Loader2 className="w-4 h-4 animate-spin" />{progress || 'Working…'}</>
                        : <><Sparkles className="w-4 h-4" />Read Aloud</>}
                </button>

                {status === 'error' && error && (
                  <div className="p-3 rounded-xl bg-red-50 border border-red-150 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-red-700">{error}</p>
                  </div>
                )}

                {/* Player */}
                {status === 'ready' && (audioUrl || instantSpeechText) && (
                  <div className="rounded-xl border border-gray-150 bg-gray-50/60 p-3 flex items-center gap-3">
                    {audioUrl && (
                      <audio
                        ref={audioRef}
                        src={audioUrl}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onEnded={() => setIsPlaying(false)}
                      />
                    )}
                    <button
                      type="button"
                      onClick={togglePlay}
                      className="w-10 h-10 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md shrink-0 cursor-pointer"
                    >
                      {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </button>
                    <p className="flex-1 text-xs text-gray-600 font-medium">
                      {isPlaying ? 'Playing selected text…' : 'Ready — press play to listen.'}
                    </p>
                    {audioUrl && (
                      <button
                        type="button"
                        onClick={handleDownload}
                        title="Download WAV"
                        className="p-2 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 cursor-pointer"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="px-5 py-2.5 border-t border-gray-100 bg-gray-50/50 flex items-center gap-1.5 text-[10px] text-gray-400">
                <FileText className="w-3 h-3" />
                Tip: select any text on the page, then press
                <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded font-mono font-bold text-gray-600">{SHORTCUT_LABEL}</kbd>
                {FALLBACK_SHORTCUT_LABEL && (
                  <>
                    <span>or</span>
                    <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded font-mono font-bold text-gray-600">{FALLBACK_SHORTCUT_LABEL}</kbd>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
