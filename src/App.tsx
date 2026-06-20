import { Headphones, Keyboard, Mic2, UploadCloud } from 'lucide-react'
import AudioReader from './components/AudioReader'
import QuickListen from './components/QuickListen'

const shortcutLabel =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? 'Option+L'
    : 'Alt+L'

function App() {
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
            </div>
          </header>

          <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <AudioReader />
            <aside className="rounded-2xl border border-slate-200 bg-white/72 p-4 shadow-xs backdrop-blur">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Scratch Text</p>
              <p className="mt-3 text-sm leading-6 text-slate-700">
                Highlight any sentence in this panel and press {shortcutLabel} to open quick listen.
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
