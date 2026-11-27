import { useEffect, useRef, useState } from 'react'
import type { PublishingClient } from './client'

export function PublishedMedia({ client, path, kind, draft = false }: { client: PublishingClient; path: string; kind: 'image' | 'audio'; draft?: boolean }) {
  const [attempt, setAttempt] = useState(0)
  return <MediaRequest key={`${path}:${draft}:${attempt}`} client={client} path={path} kind={kind} draft={draft} retry={() => setAttempt(n => n + 1)} />
}
function MediaRequest({ client, path, kind, draft, retry }: { client: PublishingClient; path: string; kind: 'image' | 'audio'; draft: boolean; retry: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [playing, setPlaying] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  const generation = useRef(0), playback = useRef<{ player: HTMLAudioElement | null }>({ player: null })
  useEffect(() => {
    const sequence = generation, owned = playback.current
    sequence.current++
    const controller = new AbortController(); let ownedUrl = ''
    client.media(path, draft, controller.signal).then(blob => {
      if (!controller.signal.aborted) { ownedUrl = URL.createObjectURL(blob); setUrl(ownedUrl) }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || 'Couldn’t load this attachment.') })
    return () => { sequence.current++; controller.abort(); owned.player?.pause(); if (ownedUrl) URL.revokeObjectURL(ownedUrl) }
  }, [client, path, draft])
  return <div className="publishing-media">
    {!url && !error && <p role="status">Loading attachment…</p>}
    {kind === 'image' && url && <img key={url} src={url} alt="Published card illustration" onError={() => setError('Couldn’t display this image. Retry.')} />}
    {kind === 'audio' && url && <><audio key={url} ref={node => { audio.current = node; if (node) playback.current.player = node }} src={url} onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} onError={() => { setPlaying(false); setError('Couldn’t play this audio. Retry.') }} /><button type="button" className="pub-button min-h-12 min-w-12" onClick={() => {
      if (playing) { generation.current++; audio.current?.pause(); if (audio.current) audio.current.currentTime = 0; setPlaying(false) }
      else { const player = audio.current, own = ++generation.current; setPlaying(true); void player?.play().then(() => { if (own !== generation.current && audio.current !== player) player?.pause() }).catch(() => { if (own === generation.current) { setPlaying(false); setError('Couldn’t play this audio. Retry.') } }) }
    }}>{playing ? 'Stop audio' : 'Play audio'}</button></>}
    {error && <div role="status"><p>{error}</p><button type="button" className="pub-button min-h-12 min-w-12" onClick={retry}>Retry attachment</button></div>}
  </div>
}
