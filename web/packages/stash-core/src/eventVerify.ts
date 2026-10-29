// Signature checks for events read from a relay, before they are kept on the
// device. The WebAssembly checker (nostr-wasm) is about six times faster than
// the plain one and is loaded on first use; if it cannot load, the plain one
// (nostr-tools/pure) is used instead.

import type { SignedEvent } from './api'

export type EventVerifier = (ev: SignedEvent) => boolean

let loading: Promise<EventVerifier> | null = null

async function load(): Promise<EventVerifier> {
  try {
    const [{ setNostrWasm, verifyEvent }, { initNostrWasm }] = await Promise.all([
      import('nostr-tools/wasm'),
      import('nostr-wasm/gzipped'),
    ])
    setNostrWasm(await initNostrWasm())
    return (ev) => verifyEvent(ev)
  } catch (err) {
    console.warn('eventVerify: WebAssembly checker unavailable, using the plain one -', (err as Error).message)
    const { verifyEvent } = await import('nostr-tools/pure')
    return (ev) => verifyEvent(ev)
  }
}

/** The events whose id and signature check out, in order. */
export async function verifiedEvents(events: SignedEvent[]): Promise<SignedEvent[]> {
  if (events.length === 0) return events
  loading ??= load()
  const verify = await loading
  return events.filter((ev) => {
    try {
      return verify(ev)
    } catch {
      return false
    }
  })
}
