// Version history dialog: lists a file's versions and allows restore.
// Calls the ported versioning.ts directly.

import { useEffect, useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import { Versioning, type FileVersion } from '../lib/versioning'
import { formatFileSize } from './format'
import type { StashFile } from '../state/types'

function fileIdOf(file: StashFile): string {
  return (file.id ||
    (file.file_id as string) ||
    (file.fileId as string) ||
    (file.d as string) ||
    file.sha256) as string
}

export function VersionHistoryModal({
  file,
  onClose,
  onRestored,
}: {
  file: StashFile | null
  onClose: () => void
  onRestored?: () => void
}) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!file) {
      setVersions(null)
      return
    }
    setVersions(null)
    setError(null)
    void Versioning.getVersionHistory(fileIdOf(file))
      .then((v) => {
        if (!cancelled) setVersions(v)
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  if (!file) return null

  const restore = async (versionNumber: number) => {
    setBusy(true)
    setError(null)
    try {
      await Versioning.restoreVersion(file as Parameters<typeof Versioning.restoreVersion>[0], versionNumber)
      onRestored?.()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={!!file} onClose={onClose} title={`Versions of "${file.name}"`} size="md">
      {error && <p className="share-status">{error}</p>}
      {versions === null ? (
        <p className="stash-muted">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="stash-muted">No previous versions.</p>
      ) : (
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.id} className="version-row">
              <span className="version-meta">
                v{v.version} · {formatFileSize(v.size)} · {Versioning.formatTimeAgo(v.timestamp)}
                {v.note ? ` · ${v.note}` : ''}
              </span>
              <button
                type="button"
                className="selection-btn"
                disabled={busy}
                onClick={() => void restore(v.version)}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
