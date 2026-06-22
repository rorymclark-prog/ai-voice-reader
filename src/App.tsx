import { useState } from 'react'
import { Headphones, Keyboard, Mic2, UploadCloud } from 'lucide-react'
import AudioReader from './components/AudioReader'
import QuickListen from './components/QuickListen'

// When opened from the "open in app window" hotkey, the selection arrives as
// ?text=… (and optional ?voice=…). Read it once, before the reader mounts.
const launchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
const launchVoice = launchParams?.get('voice') || ''
if (launchVoice) localStorage.setItem('ai_reader_voice', launchVoice)
const launchText = launchParams?.get('text') || ''

const shortcutLabel =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? 'Command+Shift+L'
    : 'Alt+L'
const fallbackShortcutLabel =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? 'Option+L'
    : ''

function App() {
  const [initialText, setInitialText] = useState<string | undefined>(launchText || undefined)

  const consumeInitialText = () => {
    setInitialText(undefined)
    // Drop the ?text= from the URL so a refresh doesn't replay it.
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }

  return (
    <>
      <QuickListen />
      <main className="min-h-svh px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <header className="flex flex-col gap-4 border-b border-slate-900/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm">
                <Headphones className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-teal-700">Standalone</p>
                <h1 className="text-2xl font-bold tracking-normal text-slate-950 sm:text-3xl">AI Voice Reader</h1>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/70 px-2.5 py-1.5">
                <UploadCloud className="h-3.5 w-3.5" />
                Files
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/70 px-2.5 py-1.5">
                <Mic2 className="h-3.5 w-3.5" />
                Natural Voice
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/70 px-2.5 py-1.5">
                <Keyboard className="h-3.5 w-3.5" />
                {shortcutLabel}
              </span>
              {fallbackShortcutLabel && (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/70 px-2.5 py-1.5">
                  <Keyboard className="h-3.5 w-3.5" />
                  {fallbackShortcutLabel}
                </span>
              )}
            </div>
          </header>

          <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <AudioReader initialText={initialText} onConsumedInitialText={consumeInitialText} />
            <aside className="rounded-2xl border border-slate-200 bg-white/72 p-4 shadow-xs backdrop-blur">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Scratch Text</p>
              <p className="mt-3 text-sm leading-6 text-slate-700">
                Highlight any sentence in this panel and press {shortcutLabel} to hear it read aloud.
                The modal can also read pasted text or documents.
              </p>
            </aside>
          </section>
        </div>
      </main>
    </>
  )
}

export default App
