import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublishingClient } from './client'
import type { ContentKind, FlashcardDraft, PublishingContent, WatchDraft } from './types'
import type { PublishedCard } from './catalogContract'
import { PublishingConfirm } from './PublishingConfirm'
import { PublishedMedia } from './PublishedMedia'
import './publishing.css'
import { deviceDrafts, draftPrefix, readDeviceDraft } from './publishingDrafts'

type Entry = { id: string; title: string; status: string; version: number }
type Detail = { id: string; draft: { version: number; content: PublishingContent } | null; published: PublishingContent | null; publication: string | null; status: string }
type Preview = { content: PublishingContent; changes: Record<string, unknown>; expectedVersion: number; expectedPublication: string | null; previewHash: string }
const newId = () => crypto.randomUUID()
const blank = (kind: ContentKind): PublishingContent => kind === 'flashcards' ? { title: '', deckType: 'vocabulary', cards: [] } : { title: '', videoId: '', level: 'A1', lines: [], breakdown: [] }
const message = (e: unknown) => e instanceof Error ? e.message : 'Couldn’t complete the request. Retry.'
export function ContentPublisher({ client, ownerKey, kind, initialContent, registerBack }: { client: PublishingClient; ownerKey: string; kind: ContentKind; initialContent?: FlashcardDraft; registerBack?: (handler: () => void) => () => void }) {
  const [scope, setScope] = useState('drafts'), [items, setItems] = useState<Entry[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null), [content, setContent] = useState<PublishingContent>(() => initialContent ?? blank(kind)), [dirty, setDirty] = useState(false)
  const [needsCompare, setNeedsCompare] = useState(false), [mediaPending, setMediaPending] = useState(false)
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState<Preview | null>(null), [history, setHistory] = useState<Record<string, unknown>[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [cardIndex, setCardIndex] = useState(0), [search, setSearch] = useState(''), [confirm, setConfirm] = useState<'archive' | 'leave' | null>(null)
  const [units, setUnits] = useState<{ id: string; title: string; course: string }[]>([]), [unitError, setUnitError] = useState('')
  const unitRequest = useRef(0), historyRequest = useRef(0)
  const lifetime = useRef(0), request = useRef(0), lock = useRef(false), pending = useRef<Record<string, unknown> | null>(null), contentRef = useRef(content)
  contentRef.current = content
  const key = `${draftPrefix(ownerKey, kind)}${selected}`
  useEffect(() => () => { lifetime.current++; request.current++ }, [])
  const loadUnits = useCallback(() => {
    const own = lifetime.current, ticket = ++unitRequest.current
    client.request<{ units: typeof units }>({ operation: 'units' }).then(r => { if (own === lifetime.current && ticket === unitRequest.current) { setUnits(r.units); setUnitError('') } }).catch(e => { if (own === lifetime.current && ticket === unitRequest.current) setUnitError(message(e)) })
  }, [client])
  const loadList = useCallback(async (after?: string) => {
    const ticket = ++request.current, own = lifetime.current
    setLoading(true); setError('')
    try {
      const result = await client.request<{ items: Entry[]; nextCursor: string | null }>({ operation: 'list', kind, scope, ...(after ? { cursor: after } : {}) })
      if (ticket !== request.current || own !== lifetime.current) return
      setItems(old => after ? [...old, ...result.items] : result.items); setCursor(result.nextCursor)
    } catch (e) { if (ticket === request.current && own === lifetime.current) setError(message(e)) }
    finally { if (ticket === request.current && own === lifetime.current) setLoading(false) }
  }, [client, kind, scope])
  useEffect(() => { void loadList(); loadUnits() }, [loadList, loadUnits])
  const open = useCallback(async (id: string) => {
    const ticket = ++request.current, own = ++lifetime.current
    pending.current = null; lock.current = false; setBusy(false); setDetail(null); setNeedsCompare(false); setSelected(id); setLoading(true); setError(''); setNotice(''); setPreview(null); setHistory([]); setHistoryCursor(null); setCardIndex(0)
    try {
      const result = await client.request<Detail>({ operation: 'get', kind, id })
      if (ticket !== request.current || own !== lifetime.current) return
      const confirmed = result.draft?.content ?? result.published ?? blank(kind)
      let restored = confirmed, hasDraft = false
      const local = readDeviceDraft(`${draftPrefix(ownerKey, kind)}${id}`, kind)
      if (local) { restored = local.content; hasDraft = JSON.stringify(restored) !== JSON.stringify(confirmed); setNeedsCompare(hasDraft && (local.baseVersion !== (result.draft?.version ?? 0) || local.publication !== result.publication)) }
      setDetail(result); setContent(restored); setDirty(hasDraft)
      if (hasDraft) setNotice('Recovered your unsaved draft. Preview it before publishing.')
      return own
    } catch (e) { if (own === lifetime.current) setError(message(e)) }
    finally { if (own === lifetime.current) setLoading(false) }
  }, [client, kind, ownerKey])
  const create = useCallback((seed?: FlashcardDraft) => {
    request.current++; lifetime.current++; pending.current = null; lock.current = false; setBusy(false)
    const c = seed ?? blank(kind), id = newId()
    setLoading(false); setNeedsCompare(false); setError('')
    try { localStorage.setItem(`${draftPrefix(ownerKey, kind)}${id}`, JSON.stringify({ content: c, baseVersion: 0, publication: null })) } catch { setError('Could not retain this draft on the device.') }
    setSelected(id); setDetail({ id, draft: null, published: null, publication: null, status: 'unpublished' }); setContent(c); setDirty(true); setPreview(null); setNotice('Draft only — nothing is shared until you publish.'); setHistory([]); setCardIndex(0)
  }, [kind, ownerKey])
  const initial = useRef(false)
  useEffect(() => { if (initialContent && !initial.current) { initial.current = true; create(initialContent) } }, [initialContent, create])
  const change = (next: PublishingContent) => {
    setContent(next); setDirty(true); setPreview(null); pending.current = null
    try { localStorage.setItem(key, JSON.stringify({ content: next, baseVersion: detail?.draft?.version ?? 0, publication: detail?.publication ?? null })) } catch { setError('This device could not retain the draft. Keep this screen open until saving succeeds.') }
  }
  const leave = useCallback(() => {
    lifetime.current++; request.current++; pending.current = null; lock.current = false
    setSelected(''); setDetail(null); setBusy(false); setConfirm(null); setError(''); setPreview(null); setDirty(false); void loadList()
  }, [loadList])
  useEffect(() => {
    if (!selected || !registerBack) return
    return registerBack(() => { if (confirm) setConfirm(null); else if (dirty) setConfirm('leave'); else leave() })
  }, [selected, registerBack, dirty, confirm, leave])
  async function mutate(operation: 'save' | 'publish' | 'archive' | 'restore', extra: Record<string, unknown> = {}, retry = false) {
    if (lock.current || !detail || (needsCompare && operation !== 'archive') || (operation === 'publish' && mediaPending)) return
    lock.current = true; setBusy(true); setError(''); setNotice('Saving…')
    const own = lifetime.current, submitted = JSON.stringify(content)
    const id = kind === 'watch' ? (content as WatchDraft).videoId : selected
    const input = retry && pending.current ? pending.current : { operation, kind, id, operationId: newId(), expectedVersion: detail.draft?.version ?? 0, expectedPublication: detail.publication, ...(operation === 'save' ? { content } : {}), ...(operation === 'publish' ? { previewHash: preview?.previewHash } : {}), ...extra }
    pending.current = input
    try {
      const result = await client.request<{ id: string; version: number; publication: string | null; status: string }> (input)
      if (own !== lifetime.current) return
      pending.current = null; setPreview(null); setConfirm(null)
      if (operation === 'restore') { localStorage.removeItem(key); const restored = await open(result.id); if (restored === lifetime.current) setNotice('Historical content restored as a draft. Preview and publish to make it shared.'); return }
      setSelected(result.id); setDetail(old => old ? { ...old, id: result.id, publication: result.publication, status: result.status, draft: { version: result.version, content }, ...(operation === 'publish' ? { published: content } : {}) } : old)
      if (submitted === JSON.stringify(contentRef.current)) {
        setDirty(false)
        try { const stored = localStorage.getItem(key); if (stored && JSON.stringify(JSON.parse(stored).content) === submitted) localStorage.removeItem(key) } catch { /* Retaining the draft is safe. */ }
      }
      setNotice(operation === 'publish' ? 'Published. Shared library readers can now refresh to see this revision.' : operation === 'archive' ? 'Archived. Existing learner copies are unchanged.' : 'Draft saved. It is not published.')
    } catch (e) { if (own === lifetime.current) { setError(message(e)); setNotice('The result is unconfirmed. Retry uses the same operation. Your draft is retained.') } }
    finally { if (own === lifetime.current) { lock.current = false; setBusy(false) } }
  }
  async function showPreview() {
    if (lock.current || !detail?.draft || dirty || mediaPending) return
    const own = lifetime.current; lock.current = true; setBusy(true); setError('')
    try { const result = await client.request<Preview>({ operation: 'preview', kind, id: selected, expectedVersion: detail.draft.version }); if (own === lifetime.current) setPreview(result) }
    catch (e) { if (own === lifetime.current) setError(message(e)) }
    finally { if (own === lifetime.current) { lock.current = false; setBusy(false) } }
  }
  async function loadHistory(after?: string) {
    const own = lifetime.current, ticket = ++historyRequest.current
    try { const result = await client.request<{ events: Record<string, unknown>[]; nextCursor: string | null }>({ operation: 'history', kind, id: selected, ...(after ? { cursor: after } : {}) }); if (own === lifetime.current && ticket === historyRequest.current) { setHistory(h => after ? [...h, ...result.events] : result.events); setHistoryCursor(result.nextCursor) } }
    catch (e) { if (own === lifetime.current && ticket === historyRequest.current) setError(message(e)) }
  }
  const cards = kind === 'flashcards' ? (content as FlashcardDraft).cards : [], card = cards[cardIndex]
  const updateCard = (next: PublishedCard) => change({ ...content as FlashcardDraft, cards: cards.map((c, i) => i === cardIndex ? next : c) })
  return <div className="publishing-workspace">
    <h2>{kind === 'flashcards' ? 'Shared flashcard publishing' : 'Watch publishing'}</h2>
    <p>Save a draft, preview the changes, then publish. Learners’ private records and review progress stay unchanged.</p>
    <div className="pub-announcement" role="status" aria-live="polite">{notice}</div>
    {error && <div className="pub-error" role="alert"><p>{error}</p>{pending.current && <button className="pub-button min-h-12 min-w-12" disabled={busy} onClick={() => void mutate(pending.current!.operation as 'save', {}, true)}>Retry operation</button>}<button className="pub-button min-h-12 min-w-12" disabled={busy} onClick={() => selected ? void open(selected) : void loadList()}>Reload confirmed content</button></div>}
    {!selected ? <>
      <div className="pub-row"><button className="pub-button min-h-12 min-w-12" onClick={() => create()}>Create {kind === 'flashcards' ? 'shared deck' : 'Watch draft'}</button>{['drafts', 'published'].map(s => <button key={s} className="pub-button min-h-12 min-w-12" aria-pressed={scope === s} onClick={() => setScope(s)}>{s === 'drafts' ? 'Drafts' : 'Published and archived'}</button>)}</div>
      {loading && <p role="status">Loading content…</p>}
      {!loading && !error && !items.length && <p>No {scope} content yet.</p>}
      {deviceDrafts(ownerKey, kind).map(d => <button className="pub-button min-h-12 min-w-12" key={`local-${d.id}`} onClick={() => void open(d.id)}>Resume device draft: {d.title}</button>)}
      {items.map(item => <button className="pub-button min-h-12 min-w-12" key={item.id} onClick={() => void open(item.id)}>{item.title || 'Untitled draft'} · {item.status}</button>)}
      {cursor && <button className="pub-button min-h-12 min-w-12" disabled={loading} onClick={() => void loadList(cursor)}>Load more content</button>}
      <button className="pub-button min-h-12 min-w-12" disabled={loading} onClick={() => void loadList()}>Refresh content</button>
    </> : <>
      <button className="pub-button min-h-12 min-w-12" onClick={() => dirty ? setConfirm('leave') : leave()}>Back to content list</button>
      {loading ? <p role="status">Loading draft…</p> : detail && <>
        <p>{detail.status} · Draft version {detail.draft?.version ?? 0}{dirty ? ' · Unsaved changes' : ''}</p>
        {needsCompare && <section className="pub-panel"><h3>A newer version was saved</h3><p>Your device draft is retained below. Compare the confirmed content before choosing to replace it.</p>{(detail.draft?.content ?? detail.published) && <ContentPreview client={client} content={(detail.draft?.content ?? detail.published)!} />}<button className="pub-button min-h-12 min-w-12" onClick={() => { setNeedsCompare(false); change(content) }}>Use my device draft after comparison</button></section>}
        <fieldset disabled={busy} className="pub-panel pub-stack">
          <legend>Content editor</legend>
          <label className="pub-label">Title<input className="pub-input" value={content.title} maxLength={300} onChange={e => change({ ...content, title: e.target.value })} /></label>
          {kind === 'flashcards' ? <>
            <label className="pub-label">Description<textarea className="pub-input" value={(content as FlashcardDraft).description ?? ''} maxLength={3000} onChange={e => change({ ...content as FlashcardDraft, description: e.target.value })} /></label>
            <div className="pub-grid"><label className="pub-label">Deck type<select className="pub-input" value={(content as FlashcardDraft).deckType} onChange={e => change({ ...content as FlashcardDraft, deckType: e.target.value as 'vocabulary' | 'grammar' })}><option value="vocabulary">Vocabulary</option><option value="grammar">Grammar</option></select></label>
              <label className="pub-label">Curriculum unit (optional)<select className="pub-input" value={(content as FlashcardDraft).unitId ?? ''} onChange={e => change({ ...content as FlashcardDraft, unitId: e.target.value })}><option value="">No linked unit</option>{(content as FlashcardDraft).unitId && !units.some(u => u.id === (content as FlashcardDraft).unitId) && <option value={(content as FlashcardDraft).unitId}>Saved unit — verify before publishing</option>}{units.map(u => <option key={u.id} value={u.id}>{u.course} · {u.title}</option>)}</select></label>
              <label className="pub-label">Level (optional)<input className="pub-input" value={(content as FlashcardDraft).level ?? ''} maxLength={128} onChange={e => change({ ...content as FlashcardDraft, level: e.target.value })} /></label></div>
            {unitError && <p>{unitError} <button type="button" className="pub-button min-h-12 min-w-12" onClick={loadUnits}>Retry units</button></p>}
            <label className="pub-label">Find a card<input className="pub-input" value={search} onChange={e => setSearch(e.target.value)} /></label>
            <div className="pub-card-list">{cards.map((c, i) => ({ c, i })).filter(({ c }) => `${c.arabicBase} ${c.english}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(({ c, i }) => <button key={c.id} type="button" className="pub-button min-h-12 min-w-12" aria-pressed={i === cardIndex} onClick={() => setCardIndex(i)}>{i + 1}. {c.english || c.arabicBase || 'Incomplete card'}</button>)}</div>
            <button type="button" className="pub-button min-h-12 min-w-12" disabled={cards.length >= 2000} onClick={() => { const grammar = (content as FlashcardDraft).deckType === 'grammar'; change({ ...content as FlashcardDraft, cards: [...cards, { id: newId(), wordType: grammar ? 'grammar' : 'noun', arabicBase: '', english: '', forms: {}, ...(grammar ? { grammar: { explanation: '', examples: [] } } : {}) }] }); setCardIndex(cards.length) }}>Add card</button>
            {card && <CardFields key={card.id} card={card} onChange={updateCard} onMove={direction => { const next = cardIndex + direction; if (next < 0 || next >= cards.length) return; const ordered = [...cards]; [ordered[cardIndex], ordered[next]] = [ordered[next], ordered[cardIndex]]; change({ ...content as FlashcardDraft, cards: ordered }); setCardIndex(next) }} onRemove={() => { change({ ...content as FlashcardDraft, cards: cards.filter(c => c.id !== card.id) }); setCardIndex(Math.max(0, cardIndex - 1)) }} />}
          </> : <WatchFields content={content as WatchDraft} onChange={change} fixedId={detail.draft !== null || detail.published !== null} />}
        </fieldset>
        {card && <MediaEditor key={selected + card.id} client={client} deckId={selected} card={card} canUpload={!!detail.draft && !busy} onChange={updateCard} onPending={setMediaPending} />}
        <div className="pub-actions"><button className="pub-button min-h-12 min-w-12" disabled={busy || needsCompare} onClick={() => void mutate('save')}>{busy ? 'Saving…' : 'Save draft'}</button><button className="pub-button min-h-12 min-w-12" disabled={busy || dirty || mediaPending || !detail.draft} onClick={() => void showPreview()}>Preview publication</button><button className="pub-button min-h-12 min-w-12" disabled={busy || !detail.publication} onClick={() => setConfirm('archive')}>Archive publication</button><button className="pub-button min-h-12 min-w-12" onClick={() => void loadHistory()}>View change history</button></div>
        {dirty && <p>Save your draft before previewing or publishing.</p>}{mediaPending && <p>Finish or discard the selected attachment before publishing.</p>}
        {preview && <section className="pub-panel pub-stack"><h3>Publication preview</h3><p>Publishing replaces the shared version. Saved learner copies change only through their existing update controls.</p><ChangeSummary changes={preview.changes} /><ContentPreview content={preview.content} client={client} /><button className="pub-button min-h-12 min-w-12" disabled={busy || dirty || mediaPending} onClick={() => void mutate('publish')}>Publish this preview</button></section>}
        {!!history.length && <section className="pub-panel"><h3>Change history</h3>{dirty && <p>Save your current draft before restoring a historical version.</p>}{history.map((event, i) => <div key={String(event.id ?? i)} className="pub-panel"><p>{String(event.operation)} · {new Date(Number(event.at)).toLocaleString()}</p><p>Publisher reference: {String((event.actor as { project?: string })?.project)} / {String((event.actor as { id?: string })?.id)}</p>{typeof event.revisionId === 'string' && <button className="pub-button min-h-12 min-w-12" disabled={busy || dirty || needsCompare} onClick={() => void mutate('restore', { revisionId: event.revisionId })}>Restore revision as draft</button>}</div>)}{historyCursor && <button className="pub-button min-h-12 min-w-12" onClick={() => void loadHistory(historyCursor)}>Load more history</button>}</section>}
      </>}
      {confirm && <PublishingConfirm title={confirm === 'archive' ? 'Archive this publication?' : 'Leave this editor?'} body={confirm === 'archive' ? 'It will leave the shared library. Learners’ saved cards remain available.' : 'Unsaved edits stay on this device. An already-issued save may still finish.'} action={confirm === 'archive' ? 'Confirm archive' : 'Leave and keep draft'} pending={confirm === 'archive' && busy} onClose={() => setConfirm(null)} onConfirm={() => confirm === 'archive' ? void mutate('archive') : leave()} registerBack={registerBack} />}
    </>}
  </div>
}

function CardFields({ card, onChange, onMove, onRemove }: { card: PublishedCard; onChange: (c: PublishedCard) => void; onMove: (direction: number) => void; onRemove: () => void }) {
  const [form, setForm] = useState(''), [remove, setRemove] = useState(false)
  const grammar = card.wordType === 'grammar', examples = grammar ? card.grammar?.examples ?? [] : card.examples ?? []
  const updateExamples = (value: typeof examples) => onChange(grammar ? { ...card, grammar: { explanation: card.grammar?.explanation ?? '', examples: value } } : { ...card, examples: value })
  return <section className="pub-panel pub-stack"><h3>Edit card</h3>
    <label className="pub-label">Card type<select className="pub-input" value={card.wordType} onChange={e => onChange({ ...card, wordType: e.target.value, ...(e.target.value === 'grammar' ? { grammar: card.grammar ?? { explanation: '', examples: [] } } : {}) })}>{[...new Set(['noun', 'verb', 'adjective', 'expression', 'particle', 'grammar', card.wordType])].map(t => <option key={t}>{t}</option>)}</select></label>
    <label className="pub-label">Arabic<input className="pub-input" dir="rtl" value={card.arabicBase} maxLength={1000} onChange={e => onChange({ ...card, arabicBase: e.target.value })} /></label>
    <label className="pub-label">Meaning<textarea className="pub-input" dir="auto" value={card.english} maxLength={3000} onChange={e => onChange({ ...card, english: e.target.value })} /></label>
    {grammar && <><label className="pub-label">Grammar classification<select className="pub-input" value={card.grammarScience ?? ''} onChange={e => { const c = { ...card }; if (e.target.value) c.grammarScience = e.target.value as 'nahw'; else delete c.grammarScience; onChange(c) }}><option value="">Unspecified</option><option value="nahw">Nahw</option><option value="sarf">Sarf</option><option value="other">Other</option></select></label><label className="pub-label">Explanation<textarea className="pub-input" value={card.grammar?.explanation ?? ''} maxLength={12000} onChange={e => onChange({ ...card, grammar: { explanation: e.target.value, examples } })} /></label></>}
    {Object.entries(card.forms).map(([name, value]) => <div className="pub-row" key={name}><label className="pub-label">{name}<input dir="rtl" className="pub-input" value={value} maxLength={3000} onChange={e => onChange({ ...card, forms: { ...card.forms, [name]: e.target.value } })} /></label><button type="button" className="pub-button min-h-12 min-w-12" aria-label={`Remove ${name} form`} onClick={() => { const forms = { ...card.forms }; delete forms[name]; onChange({ ...card, forms }) }}>Remove form</button></div>)}
    <label className="pub-label">New form name<input className="pub-input" value={form} maxLength={40} onChange={e => setForm(e.target.value)} /></label><button type="button" className="pub-button min-h-12 min-w-12" disabled={!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(form) || ['constructor', 'prototype', '__proto__'].includes(form) || form in card.forms || Object.keys(card.forms).length >= 32} onClick={() => { onChange({ ...card, forms: { ...card.forms, [form]: '' } }); setForm('') }}>Add form</button>
    {examples.map((ex, i) => <div key={i} className="pub-panel pub-stack"><label className="pub-label">Arabic example {i + 1}<textarea dir="rtl" className="pub-input" maxLength={3000} value={ex.ar} onChange={e => updateExamples(examples.map((p, n) => n === i ? { ...p, ar: e.target.value } : p))} /></label><label className="pub-label">English example {i + 1}<textarea className="pub-input" maxLength={3000} value={ex.en ?? ''} onChange={e => updateExamples(examples.map((p, n) => n === i ? { ...p, en: e.target.value } : p))} /></label><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => updateExamples(examples.filter((_, n) => n !== i))}>Remove example {i + 1}</button></div>)}
    <button type="button" className="pub-button min-h-12 min-w-12" disabled={examples.length >= 20} onClick={() => updateExamples([...examples, { ar: '', en: '' }])}>Add example</button>
    <div className="pub-row"><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => onMove(-1)}>Move card up</button><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => onMove(1)}>Move card down</button><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => setRemove(true)}>Remove card from draft</button></div>
    {remove && <div><p>Remove this card from the draft? Existing personal copies stay unchanged.</p><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => setRemove(false)}>Cancel removal</button><button type="button" className="pub-button min-h-12 min-w-12" onClick={onRemove}>Confirm removal</button></div>}
  </section>
}

function WatchFields({ content, onChange, fixedId }: { content: WatchDraft; onChange: (c: WatchDraft) => void; fixedId: boolean }) {
  const [json, setJson] = useState(''), [imported, setImported] = useState<Pick<WatchDraft, 'lines' | 'breakdown'> | null>(null), [error, setError] = useState(''), [lineIndex, setLineIndex] = useState(0)
  const line = content.lines[lineIndex], entry = content.breakdown[lineIndex] ?? { tr: '', w: [] }
  const update = (lineValue = line, entryValue = entry) => onChange({ ...content, lines: content.lines.map((l, i) => i === lineIndex ? lineValue : l), breakdown: content.lines.map((_, i) => i === lineIndex ? entryValue : content.breakdown[i] ?? null) })
  return <>
    <label className="pub-label">YouTube video ID or link<input className="pub-input" disabled={fixedId} value={content.videoId} onChange={e => { let id = e.target.value; try { const u = new URL(id); if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(u.hostname)) id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') ?? u.pathname.match(/\/(?:shorts|embed)\/([\w-]+)/)?.[1] ?? id } catch { /* Raw ID is validated by the server. */ } onChange({ ...content, videoId: id }) }} /></label>
    <label className="pub-label">Level<select className="pub-input" value={content.level} onChange={e => onChange({ ...content, level: e.target.value })}>{['A1','A2','B1','B2','C1','C2'].map(l => <option key={l}>{l}</option>)}</select></label>
    <p>Add supplied captions and meanings. This editor does not request AI or transcription.</p>
    <label className="pub-label">Caption line<select className="pub-input" value={lineIndex} onChange={e => setLineIndex(Number(e.target.value))}>{content.lines.map((l, i) => <option key={i} value={i}>{i + 1}. {l.text || 'New caption'}</option>)}</select></label>
    <button type="button" className="pub-button min-h-12 min-w-12" disabled={content.lines.length >= 2000} onClick={() => { onChange({ ...content, lines: [...content.lines, { start: 0, dur: 3, text: '' }], breakdown: [...content.breakdown, null] }); setLineIndex(content.lines.length) }}>Add caption line</button>
    {line && <div className="pub-panel pub-stack"><div className="pub-grid"><label className="pub-label">Start (seconds)<input className="pub-input" type="number" min="0" step="0.01" value={line.start} onChange={e => update({ ...line, start: Number(e.target.value) })} /></label><label className="pub-label">Duration (seconds)<input className="pub-input" type="number" min="0.01" step="0.01" value={line.dur} onChange={e => update({ ...line, dur: Number(e.target.value) })} /></label></div>
      <label className="pub-label">Arabic caption<textarea className="pub-input" dir="rtl" value={line.text} maxLength={3000} onChange={e => update({ ...line, text: e.target.value })} /></label><label className="pub-label">Caption translation (optional)<textarea className="pub-input" value={entry.tr} maxLength={3000} onChange={e => update(line, { ...entry, tr: e.target.value })} /></label>
      {entry.w.map((w, i) => <div className="pub-grid" key={i}><label className="pub-label">Arabic word {i + 1}<input className="pub-input" dir="rtl" value={w.ar} maxLength={1000} onChange={e => update(line, { ...entry, w: entry.w.map((word, n) => n === i ? { ...word, ar: e.target.value } : word) })} /></label><label className="pub-label">Meaning {i + 1}<input className="pub-input" value={w.en} maxLength={3000} onChange={e => update(line, { ...entry, w: entry.w.map((word, n) => n === i ? { ...word, en: e.target.value } : word) })} /></label><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => update(line, { ...entry, w: entry.w.filter((_, n) => n !== i) })}>Remove word {i + 1}</button></div>)}
      <button type="button" className="pub-button min-h-12 min-w-12" disabled={entry.w.length >= 200} onClick={() => update(line, { ...entry, w: [...entry.w, { ar: '', en: '' }] })}>Add word meaning</button><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => { onChange({ ...content, lines: content.lines.filter((_, i) => i !== lineIndex), breakdown: content.breakdown.filter((_, i) => i !== lineIndex) }); setLineIndex(0) }}>Remove caption line</button></div>}
    <label className="pub-label">Import captions JSON<textarea className="pub-input pub-json" value={json} onChange={e => { setJson(e.target.value); setImported(null) }} placeholder={'{"lines":[{"start":0,"dur":3,"text":"…"}],"breakdown":[null]}'} /></label>
    <button type="button" className="pub-button min-h-12 min-w-12" onClick={() => { try { if (new TextEncoder().encode(json).length > 790000) throw new Error('Caption JSON is too large.'); const data = JSON.parse(json); if (!Array.isArray(data.lines) || data.lines.length > 2000 || data.lines.some((l: WatchDraft['lines'][number]) => typeof l?.text !== 'string' || !Number.isFinite(l.start) || l.start < 0 || !Number.isFinite(l.dur) || l.dur <= 0)) throw new Error('Provide valid timed caption lines; nothing was imported.'); const breakdown = data.breakdown ?? data.lines.map(() => null); if (!Array.isArray(breakdown) || breakdown.length !== data.lines.length || breakdown.some((b: WatchDraft['breakdown'][number]) => b !== null && (typeof b?.tr !== 'string' || !Array.isArray(b.w) || b.w.some(w => typeof w.ar !== 'string' || typeof w.en !== 'string')))) throw new Error('Translations and meanings must match their captions.'); setImported({ lines: data.lines, breakdown }); setError('') } catch (e) { setError(message(e)); setImported(null) } }}>Preview caption import</button>
    {error && <p role="alert">{error}</p>}{imported && <div className="pub-panel"><p>{imported.lines.length} captions will replace this draft’s captions. Nothing is published.</p><div className="pub-preview">{imported.lines.map((l, i) => <p key={i} dir="auto">{l.start}s · {l.text} · {imported.breakdown[i]?.tr || 'Translation unavailable'}</p>)}</div><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => { onChange({ ...content, ...imported }); setImported(null); setJson(''); setLineIndex(0) }}>Use imported captions</button></div>}
  </>
}

function MediaEditor({ client, deckId, card, canUpload, onChange, onPending }: { client: PublishingClient; deckId: string; card: PublishedCard; canUpload: boolean; onChange: (c: PublishedCard) => void; onPending: (pending: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null), [assetId, setAssetId] = useState(newId), [progress, setProgress] = useState(0), [error, setError] = useState(''), [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null), latest = useRef(card), onChangeRef = useRef(onChange), alive = useRef(true)
  latest.current = card; onChangeRef.current = onChange
  useEffect(() => { onPending(file !== null); return () => onPending(false) }, [file, onPending])
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  const upload = async () => {
    if (!file || controller.current || !canUpload) return
    const c = new AbortController(); controller.current = c; setUploading(true); setError('')
    try { const media = await client.upload(deckId, assetId, file, setProgress, c.signal); if (alive.current && !c.signal.aborted) { if (!(latest.current.media ?? []).some(m => m.path === media.path)) onChangeRef.current({ ...latest.current, media: [...latest.current.media ?? [], media] }); setFile(null); setAssetId(newId()); setProgress(0) } }
    catch (e) { if (alive.current) setError(message(e)) }
    finally { if (alive.current) setUploading(false); if (controller.current === c) controller.current = null }
  }
  return <section className="pub-panel pub-stack"><h3>Card attachments</h3><p>Upload an approved image or audio file. Save the draft again after attaching it. Private URLs are not accepted.</p>{!canUpload && <p>Save the deck draft before uploading.</p>}
    {(card.media ?? []).map(m => <div key={m.path}><PublishedMedia client={client} path={m.path} kind={m.kind} draft /><button className="pub-button min-h-12 min-w-12" disabled={uploading || !canUpload} onClick={() => onChange({ ...card, media: card.media?.filter(x => x.path !== m.path) })}>Remove attachment from draft</button></div>)}
    <p>Image or audio file</p><input aria-label="Image or audio file" aria-hidden="true" tabIndex={-1} ref={fileInput} className="pub-file-input" type="file" accept=".png,.jpg,.jpeg,.webp,.mp3,.wav,.ogg" disabled={uploading || !canUpload || (card.media?.length ?? 0) >= 8} onChange={e => { setFile(e.target.files?.[0] ?? null); setAssetId(newId()); setError(''); setProgress(0) }} /><button type="button" className="pub-button min-h-12 min-w-12" disabled={uploading || !canUpload || (card.media?.length ?? 0) >= 8} onClick={() => fileInput.current?.click()}>Choose image or audio</button>
    {file && <p>{file.name} · {Math.ceil(file.size / 1024)} KB</p>}{uploading && <p role="status">Uploading {progress}%</p>}{error && <p role="status">{error}</p>}<div className="pub-row"><button className="pub-button min-h-12 min-w-12" disabled={!file || uploading || !canUpload} onClick={() => void upload()}>{error ? 'Retry upload' : 'Upload attachment'}</button>{uploading && <button className="pub-button min-h-12 min-w-12" onClick={() => controller.current?.abort()}>Cancel upload</button>}{file && !uploading && <button className="pub-button min-h-12 min-w-12" onClick={() => { setFile(null); setError(''); setProgress(0); setAssetId(newId()) }}>Discard selected attachment</button>}</div>
  </section>
}
function ContentPreview({ content, client }: { content: PublishingContent; client: PublishingClient }) {
  return <div className="pub-preview"><h3>{content.title}</h3>{'cards' in content ? content.cards.map(c => <article className="pub-panel" key={c.id}><p dir="rtl">{c.arabicBase}</p><p>{c.english}</p>{Object.entries(c.forms).map(([k,v]) => <p key={k}>{k}: <bdi>{v}</bdi></p>)}{c.grammar && <p>{c.grammar.explanation}</p>}{[...c.examples ?? [], ...c.grammar?.examples ?? []].map((e,i) => <blockquote key={i}><p dir="rtl">{e.ar}</p><p>{e.en || 'Translation unavailable'}</p></blockquote>)}{c.media?.map(m => <PublishedMedia key={m.path} client={client} path={m.path} kind={m.kind} draft />)}</article>) : content.lines.map((l,i) => <article key={i}><p>{l.start}s–{l.start + l.dur}s</p><p dir="rtl">{l.text}</p><p>{content.breakdown[i]?.tr || 'Translation unavailable'}</p><p>{content.breakdown[i]?.w.map(w => `${w.ar}: ${w.en}`).join(' · ') || 'Word meanings unavailable'}</p></article>)}</div>
}

function ChangeSummary({ changes }: { changes: Record<string, unknown> }) {
  return 'added' in changes ? <ul><li>{(changes.added as unknown[]).length} cards added</li><li>{(changes.changed as unknown[]).length} cards changed</li><li>{(changes.removed as unknown[]).length} cards removed</li><li>{changes.orderChanged ? 'Card order changes.' : 'Card order is unchanged.'}</li><li>{changes.metadataChanged ? 'Deck information changes.' : 'Deck information is unchanged.'}</li></ul> : <p>{String(changes.captionsBefore)} captions before; {String(changes.captionsAfter)} after. {changes.contentChanged ? 'Watch content changes.' : 'No content changes.'}</p>
}
