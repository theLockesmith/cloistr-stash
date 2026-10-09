// Edit one of the user's own replaceable/addressable events (kind 30078 file
// metadata, 30079 folders) by loading it from the relay and changing only what
// the caller changes. Found 2026-10-09 (cross-frontend sweep): rebuilding these
// events from in-memory list rows dropped every tag the row did not carry,
// including a file's only key copy (owner_key), its version history (v/current)
// and a folder's wrapped file keys (wk). A timeout or no answer is an error,
// never "empty": nothing is published unless the current event was loaded.

import { authPort } from './authBridge'
import { Relay } from './relay'

export class EventUnavailableError extends Error {
  constructor(public readonly kind: number, public readonly d: string, detail: string) {
    super(`Could not load the current record (${detail}). Nothing was changed; try again.`)
    this.name = 'EventUnavailableError'
  }
}

export interface OwnEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

/** The user's current event for (kind, d). Throws unless the relay answered with it. */
export async function loadOwnEvent(kind: number, d: string): Promise<OwnEvent> {
  const me = authPort.pubkey
  if (!me) throw new EventUnavailableError(kind, d, 'not signed in')
  let events: OwnEvent[]
  try {
    // Relay.subscribe rejects on a timeout; [] only after EOSE.
    events = (await Relay.subscribe({ kinds: [kind], authors: [me], '#d': [d] }, 10_000)) as unknown as OwnEvent[]
  } catch (err) {
    throw new EventUnavailableError(kind, d, (err as Error).message)
  }
  if (events.length === 0) throw new EventUnavailableError(kind, d, 'the relay has no record of it')
  return events.reduce((a, b) => (b.created_at > a.created_at ? b : a))
}

/** Tags plus parsed JSON content, for an edit to change in place. */
export interface EventDraft {
  tags: string[][]
  content: Record<string, unknown>
}

export function setTag(draft: EventDraft, name: string, value: string | null): void {
  draft.tags = draft.tags.filter((t) => t[0] !== name)
  if (value !== null) draft.tags.push([name, value])
}

/**
 * Load the current event, let `edit` change the draft, and re-publish it,
 * strictly newer than the event it replaces. `edit` returns false to publish
 * nothing (no change needed). Returns whether an event was published.
 */
export async function editOwnEvent(
  kind: number,
  d: string,
  edit: (draft: EventDraft, current: OwnEvent) => boolean | void | Promise<boolean | void>,
): Promise<boolean> {
  const current = await loadOwnEvent(kind, d)
  let content: Record<string, unknown>
  try {
    content = JSON.parse(current.content) as Record<string, unknown>
  } catch {
    throw new EventUnavailableError(kind, d, 'its record is not readable')
  }
  const draft: EventDraft = { tags: current.tags.map((t) => [...t]), content }
  if ((await edit(draft, current)) === false) return false
  const event = await authPort.signEvent({
    kind,
    // Strictly newer than the event it replaces, even with clock skew.
    created_at: Math.max(Math.floor(Date.now() / 1000), current.created_at + 1),
    tags: draft.tags,
    content: JSON.stringify(draft.content),
  })
  await authPort.publishEvent(event)
  return true
}
