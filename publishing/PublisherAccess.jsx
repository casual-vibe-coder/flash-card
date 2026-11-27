import { useCallback, useEffect, useRef, useState } from 'react'
import { usePublishingClient } from './usePublishingClient'
import { ContentPublisher } from './ContentPublisher'
import { prepareSourceDeck } from './sourceSelection'
import './publishing.css'

export function usePublisherAccess(auth, user) {
  const client = usePublishingClient(auth, import.meta.env.VITE_CONTENT_PUBLISHING_URL, user?.uid ?? '')
  const [state, setState] = useState('checking'), [error, setError] = useState(''), [checked, setChecked] = useState(null)
  const request = useRef(0)
  const check = useCallback(async () => {
    const ticket = ++request.current
    setChecked({ client, user }); setState('checking'); setError('')
    if (!user || !import.meta.env.VITE_CONTENT_PUBLISHING_URL) { setState('unavailable'); return }
    try {
      const access = await client.request({ operation: 'access' })
      if (ticket === request.current) setState(access.project === 'flash-card' && access.capabilities.includes('flashcards') ? 'allowed' : 'denied')
    } catch (e) { if (ticket === request.current) { setState('unverified'); setError(e.message) } }
  }, [client, user])
  useEffect(() => {
    void check()
    const foreground = () => { if (!document.hidden) void check() }
    const offline = () => { request.current++; setState('unverified'); setError('Publishing requires a verified connection.') }
    window.addEventListener('focus', foreground); window.addEventListener('online', foreground); window.addEventListener('offline', offline); document.addEventListener('visibilitychange', foreground)
    return () => { request.current++; window.removeEventListener('focus', foreground); window.removeEventListener('online', foreground); window.removeEventListener('offline', offline); document.removeEventListener('visibilitychange', foreground) }
  }, [check])
  return { client, state: checked?.client === client && checked?.user === user ? state : 'checking', error, check }
}

export function PublisherAccess({ access, user, decks, cardStates, presets, loadPresets, onBack }) {
  const [seed, setSeed] = useState(null), [selected, setSelected] = useState(''), [shared, setShared] = useState(presets), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const alive = useRef(true), lock = useRef(false)
  useEffect(() => { alive.current = true; void access.check(); return () => { alive.current = false } }, [access.check])
  async function refreshPresets() {
    if (lock.current) return
    lock.current = true; setLoading(true); setError('')
    try { const result = await loadPresets(); if (alive.current) setShared([...presets.filter(p => !result.some(r => r.id === p.id)), ...result]) }
    catch { if (alive.current) setError('Couldn’t read shared presets. Retry. Bundled presets remain separately identified.') }
    finally { lock.current = false; if (alive.current) setLoading(false) }
  }
  return <main className="publishing-workspace source-publisher">
    <button className="pub-button" onClick={onBack}>Back to Settings</button>
    <h1>Shared catalog publishing</h1>
    {access.state !== 'allowed' ? <div><p>{access.state === 'checking' ? 'Checking publisher access…' : access.error || 'Publishing is unavailable for this account.'}</p><button className="pub-button" onClick={access.check}>Retry access</button></div> : <>
      <section className="pub-panel pub-stack"><h2>Prepare from existing content</h2><p>Choose one owned deck or shared preset. Review the exact content below before saving or publishing. Private notes, captures, grades, schedules, accounts and private media links are excluded. Upload approved attachments separately; choose a valid Kayfa curriculum unit in the editor.</p>
        <label className="pub-label">Source deck<select className="pub-input" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose explicitly</option><optgroup label="My owned decks">{decks.map(d => <option key={d.id} value={`owned:${d.id}`}>{d.title}</option>)}</optgroup><optgroup label="Shared presets (bundled and loaded)">{shared.map(d => <option key={d.id} value={`preset:${d.id}`}>{d.title}</option>)}</optgroup></select></label>
        <button className="pub-button" disabled={loading} onClick={refreshPresets}>{loading ? 'Loading presets…' : 'Load or retry central presets'}</button>
        {error && <p role="alert">{error}</p>}
        <button className="pub-button" disabled={!selected} onClick={() => {
          try { const owned = selected.startsWith('owned:'), id = selected.slice(selected.indexOf(':') + 1), deck = (owned ? decks : shared).find(d => d.id === id); if (!deck) throw new Error('Select an available source deck.'); const content = prepareSourceDeck(deck, owned ? cardStates[id] ?? [] : deck.cards); setSeed({ key: crypto.randomUUID(), content }); setError('') } catch (e) { setError(e.message) }
        }}>Prepare a private shared-catalog draft</button>
      </section>
      <ContentPublisher key={`${user.uid}:${seed?.key ?? 'catalog'}`} client={access.client} ownerKey={`flash-card:${user.uid}`} kind="flashcards" initialContent={seed?.content} />
    </>}
  </main>
}
