// The Stash embed (/embed/files): the user's drive, listed inside Stash's own
// origin, framed by an allow-listed Cloistr app. See protocol.ts for the
// contract. The root key, folder keys and file keys stay in this origin; the
// parent receives only what the user picks.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNostrAuth } from '@cloistr/auth'
import { useSharedSession } from '@cloistr/ui/components'
import { updateAuth, type Signer } from '@cloistr/stash-core/authBridge'
import type { DriveSnapshot } from '@cloistr/stash-core/drive'
import { fetchDrive, filesIn, foldersIn } from '../state/driveSource'
import { EmbedView, type EmbedState } from './EmbedView'
import { postToParent, toPicked, type EmbedMode } from './protocol'

/** Folder path from the root to `folderId`, by parent_id; stops on a cycle. */
export function folderPath(drive: DriveSnapshot, folderId: string): { id: string; name: string }[] {
  const byId = new Map(drive.folders.map((f) => [f.id, f]))
  const path: { id: string; name: string }[] = []
  const seen = new Set<string>()
  let id = folderId
  while (id && !seen.has(id)) {
    seen.add(id)
    const f = byId.get(id)
    if (!f) break
    path.unshift({ id: f.id, name: f.name })
    id = f.parent_id || ''
  }
  return path
}

export function EmbedApp({ parent, mode }: { parent: string; mode: EmbedMode }) {
  const { authState, signer } = useNostrAuth()
  const { isResolving } = useSharedSession()
  const isConnected = !!authState?.isConnected
  const pubkey = authState?.pubkey ?? null
  const connecting = !!authState?.isConnecting || !!authState?.isSwitching || isResolving

  const [drive, setDrive] = useState<DriveSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [folderId, setFolderId] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [attempt, setAttempt] = useState(0)

  const post = useCallback((msg: Parameters<typeof postToParent>[2]) => postToParent(window.parent, parent, msg), [parent])

  useEffect(() => {
    if (!connecting) post({ type: 'ready', signedIn: isConnected })
  }, [connecting, isConnected, post])

  useEffect(() => {
    let cancelled = false
    setDrive(null)
    setError(null)
    if (!isConnected || !pubkey) return
    void (async () => {
      try {
        await updateAuth((signer as Signer | null) ?? null, { isConnected, pubkey })
        const d = await fetchDrive(pubkey)
        if (!cancelled) setDrive(d)
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'unknown error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [signer, isConnected, pubkey, attempt])

  // Tell the parent how tall the content is, so it can size the frame.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = -1
    const ro = new ResizeObserver(() => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      if (height !== last) {
        last = height
        post({ type: 'resize', height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [post])

  const state: EmbedState = useMemo(() => {
    if (connecting) return { kind: 'connecting' }
    if (!isConnected) return { kind: 'signed-out' }
    if (error) return { kind: 'error', message: error }
    if (!drive) return { kind: 'loading' }
    return {
      kind: 'list',
      path: folderPath(drive, folderId),
      folders: foldersIn(drive, folderId),
      files: filesIn(drive, folderId),
      unreadable: drive.unreadable.length,
    }
  }, [connecting, isConnected, error, drive, folderId])

  const onToggleFile = useCallback((sha256: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sha256)) next.delete(sha256)
      else next.add(sha256)
      return next
    })
  }, [])

  const onChoose = useCallback(() => {
    if (!drive || selected.size === 0) return
    const items = drive.files.filter((f) => selected.has(f.sha256) && !f.deleted_at).map(toPicked)
    post({ type: 'picked', items })
    setSelected(new Set())
  }, [drive, selected, post])

  return (
    <div ref={rootRef}>
      <EmbedView
        state={state}
        mode={mode}
        appUrl={window.location.origin}
        selected={selected}
        onOpenFolder={setFolderId}
        onToggleFile={onToggleFile}
        onChoose={onChoose}
        onCancel={() => {
          setSelected(new Set())
          post({ type: 'cancelled' })
        }}
        // Signed out: the sign-in happened in another tab, so only a reload
        // picks up the new session. Otherwise re-fetch the drive.
        onRetry={() => (state.kind === 'signed-out' ? window.location.reload() : setAttempt((n) => n + 1))}
      />
    </div>
  )
}
