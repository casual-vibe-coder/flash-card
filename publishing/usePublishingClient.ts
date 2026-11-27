import { useEffect, useMemo, useRef } from 'react'
import type { Auth } from 'firebase/auth'
import { createContentPublishingClient } from './client'
export function usePublishingClient(auth: Auth, endpoint: string | undefined, owner: string) {
  const client = useMemo(() => createContentPublishingClient(auth, endpoint, owner), [auth, endpoint, owner])
  const lifetimes = useRef(new Map<typeof client, number>())
  useEffect(() => {
    const counts = lifetimes.current
    counts.set(client, (counts.get(client) ?? 0) + 1)
    return () => { counts.set(client, (counts.get(client) ?? 1) - 1); queueMicrotask(() => { if (!counts.get(client)) { client.dispose(); counts.delete(client) } }) }
  }, [client])
  return client
}
