import { onAuthStateChanged, type Auth } from 'firebase/auth'

export interface PublishingClient {
  request: <T = unknown>(body: Record<string, unknown>, signal?: AbortSignal) => Promise<T>
  upload: (deckId: string, assetId: string, file: File, progress: (value: number) => void, signal: AbortSignal) => Promise<{ kind: 'image' | 'audio'; path: string }>
  media: (path: string, draft: boolean, signal: AbortSignal) => Promise<Blob>
  dispose: () => void
}
/** Each mounted consumer owns its client. Account epochs also reject A→B→A. */
export function createContentPublishingClient(auth: Auth, endpoint: string | undefined, expectedUid?: string): PublishingClient {
  let epoch = 0, disposed = false, uid = auth.currentUser?.uid
  const active = new Set<AbortController>()
  let unsubscribe: (() => void) | undefined
  const subscribe = () => unsubscribe ??= onAuthStateChanged(auth, user => {
    if (uid !== user?.uid) { uid = user?.uid; epoch++; active.forEach(c => c.abort()) }
  })
  async function authorized<T>(signal: AbortSignal | undefined, work: (token: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!endpoint) throw new Error('Content publishing is not configured yet.')
    const owner = auth.currentUser, started = epoch
    if (!owner || disposed || (expectedUid !== undefined && owner.uid !== expectedUid)) throw new Error('Please sign in again.')
    subscribe()
    const controller = new AbortController(), abort = () => controller.abort()
    const timeout = setTimeout(abort, 65000)
    active.add(controller); signal?.addEventListener('abort', abort, { once: true })
    const check = () => { if (disposed || started !== epoch || auth.currentUser !== owner || signal?.aborted || controller.signal.aborted) throw new DOMException('Request no longer belongs to this screen.', 'AbortError') }
    try { check(); const token = await owner.getIdToken(); check(); const result = await work(token, controller.signal); check(); return result }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); active.delete(controller) }
  }
  async function readResponse(response: Response) {
    if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.error?.message ?? 'The request failed. Retry.') }
    return response
  }
  return {
    request: <T,>(body: Record<string, unknown>, signal?: AbortSignal) => authorized(signal, async (token, ownedSignal) => {
      const response = await fetch(endpoint!, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ownedSignal })
      return (await readResponse(response)).json() as Promise<T>
    }),
    media: (path, draft, signal) => authorized(signal, async (token, ownedSignal) => (await readResponse(await fetch(endpoint!, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'media', path, draft }), signal: ownedSignal }))).blob()),
    upload: (deckId, assetId, file, progress, signal) => authorized(signal, (token, ownedSignal) => new Promise((resolve, reject) => {
      const extension = file.name.split('.').pop()?.toLowerCase().replace('jpeg', 'jpg') ?? ''
      if (!['png', 'jpg', 'webp', 'mp3', 'wav', 'ogg'].includes(extension) || file.size > (['png', 'jpg', 'webp'].includes(extension) ? 5 : 20) * 1024 * 1024) { reject(new Error('Use PNG/JPG/WebP up to 5 MB or MP3/WAV/OGG up to 20 MB.')); return }
      const url = new URL(endpoint!), xhr = new XMLHttpRequest()
      for (const [k, v] of Object.entries({ operation: 'upload', deckId, assetId, extension })) url.searchParams.set(k, v)
      const abort = () => xhr.abort(), cleanup = () => ownedSignal.removeEventListener('abort', abort)
      xhr.open('POST', url); xhr.setRequestHeader('Authorization', `Bearer ${token}`); xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.timeout = 60000
      xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)) }
      xhr.onload = () => { cleanup(); try { const data = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) reject(new Error(data?.error?.message ?? 'Upload failed. Retry.')); else resolve(data) } catch { reject(new Error('Upload acknowledgement was lost. Retry the same file.')) } }
      xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new Error('Upload acknowledgement was lost. Retry the same file.')) }
      xhr.onabort = () => { cleanup(); reject(new DOMException('Upload stopped. A completed server upload may be reused on Retry.', 'AbortError')) }
      ownedSignal.addEventListener('abort', abort, { once: true }); if (ownedSignal.aborted) { cleanup(); reject(new DOMException('Upload stopped.', 'AbortError')) } else xhr.send(file)
    })),
    dispose: () => { disposed = true; epoch++; unsubscribe?.(); active.forEach(c => c.abort()); active.clear() },
  }
}
