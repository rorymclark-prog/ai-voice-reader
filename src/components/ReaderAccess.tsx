import { useEffect, useState } from 'react';

export default function ReaderAccess() {
  const [state, setState] = useState<'loading' | 'locked' | 'unlocked' | 'offline'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetch('/api/reader').then(r => r.json()).then(data => {
      if (active) setState(data.unlocked ? 'unlocked' : data.available ? 'locked' : 'offline');
    }).catch(() => { if (active) setState('offline'); });
    return () => { active = false; };
  }, []);
  if (state === 'unlocked' || state === 'loading') return null;
  if (state === 'offline') return <p role="status">Cloud reading is unavailable. You can still use a device voice for text.</p>;
  return <form className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4" onSubmit={async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = new FormData(form).get('code');
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/reader', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({operation:'unlock', code})});
      const result = await response.json();
      if (!response.ok || !result.unlocked) throw new Error(result.error || 'Could not unlock cloud reading.');
      form.reset();
      setState('unlocked');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { setBusy(false); }
  }}>
    <label className="grid gap-1 text-sm font-semibold">Reader access code
      <input className="rounded-lg border border-slate-300 px-3 py-2" name="code" type="password" autoComplete="current-password" required />
    </label>
    <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-white" disabled={busy}>Unlock cloud reading</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
