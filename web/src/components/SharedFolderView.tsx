// Browsing a folder someone shared with us, one level at a time, with the
// shared folder key: the files that key opens and the subfolders it reaches.
// Nothing here touches our own drive or root key. Old-shape subfolders of an
// unmigrated drive do not appear: their keys are wrapped to the owner only.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@cloistr/ui/components'
import { Crypto } from '@cloistr/stash-core/crypto'
import type { DriveSnapshot } from '@cloistr/stash-core/drive'
import { Sharing, type DecryptedIncomingShare } from '@cloistr/stash-core/sharing'
import type { StashFile } from '../state/types'
import { formatFileSize, getFileIcon } from './format'

/**
 * Save bytes as a download. The sender chose the name and type: a same-origin
 * blob typed text/html would run as this app if opened, so it is always
 * application/octet-stream.
 */
export function saveAsDownload(data: Uint8Array, name: string): void {
  const blobUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }))
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = name.replace(/[\\/\u0000-\u001f]/g, '_') || 'shared-file'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
}

interface Level {
  id: string
  name: string
  key: Uint8Array
}

export function SharedFolderView({
  share,
  name,
  onClose,
}: {
  share: DecryptedIncomingShare
  name: string
  onClose: () => void
}) {
  const toast = useToast()
  const [path, setPath] = useState<Level[]>([])
  const [snap, setSnap] = useState<DriveSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyFileId, setBusyFileId] = useState<string | null>(null)

  // Bumped by every navigation and by close: a listing that resolves after a
  // newer one (or after close) is dropped and its keys wiped at once.
  const generation = useRef(0)
  // Every key the view was handed while open (the share's, and every listed
  // level's); all wiped on close. Kept until then because the path holds
  // subfolder keys taken from earlier levels.
  const held = useRef<Uint8Array[]>([])

  const open = useCallback(
    async (next: Level[]) => {
      const mine = ++generation.current
      setPath(next)
      setSnap(null)
      setError(null)
      const level = next[next.length - 1]
      try {
        const listed = await Sharing.browseSharedFolder(share.owner_pubkey, level.id, level.key)
        const keys = [...listed.fileKeys.values(), ...listed.folderKeys.values()]
        if (mine !== generation.current) {
          keys.forEach((k) => Crypto.wipeKey(k))
          return
        }
        held.current.push(...keys)
        setSnap(listed)
      } catch (err) {
        if (mine !== generation.current) return
        console.error('Shared folder listing failed', err)
        setError(`Could not open this folder: ${(err as Error).message}`)
      }
    },
    [share.owner_pubkey],
  )

  useEffect(() => {
    let closed = false
    Sharing.sharedFolderKey(share)
      .then(({ folderId, key }) => {
        if (closed) return Crypto.wipeKey(key)
        held.current.push(key)
        return open([{ id: folderId, name, key }])
      })
      .catch((err) => {
        if (!closed) setError(`Could not open this folder: ${(err as Error).message}`)
      })
    return () => {
      closed = true
      generation.current++
      held.current.splice(0).forEach((k) => Crypto.wipeKey(k))
    }
  }, [share, name, open])

  const openSubfolder = (folderId: string, folderName: string) => {
    const key = snap?.folderKeys.get(folderId)
    if (!key) return
    void open([...path, { id: folderId, name: folderName, key }])
  }

  const onDownload = async (file: StashFile) => {
    const key = snap?.fileKeys.get(file.id!)
    if (!key) return
    setBusyFileId(file.id!)
    try {
      const { data, name: fileName } = await Sharing.downloadFromSharedFolder(file, key)
      saveAsDownload(data, fileName)
    } catch (err) {
      console.error('Shared folder download failed', err)
      const e = err as Error
      toast.error(e.name === 'SharedKeyCannotOpenError' ? e.message : `Download failed: ${e.message}`)
    } finally {
      setBusyFileId(null)
    }
  }

  const files = (snap?.files ?? []).filter((f) => !f.deleted_at)
  const folders = snap?.folders ?? []

  return (
    <div className="file-browser shared-folder">
      <nav className="breadcrumbs" aria-label="Shared folder path">
        <button type="button" className="breadcrumb-item" onClick={onClose}>
          Shared
        </button>
        {path.map((level, i) => (
          <span key={level.id}>
            <span className="breadcrumb-sep" aria-hidden="true">/</span>
            {i === path.length - 1 ? (
              <span className="breadcrumb-current" aria-current="page">{level.name}</span>
            ) : (
              <button type="button" className="breadcrumb-item" onClick={() => void open(path.slice(0, i + 1))}>
                {level.name}
              </button>
            )}
          </span>
        ))}
      </nav>

      {error ? (
        <div className="fb-status fb-error">{error}</div>
      ) : !snap ? (
        <div className="fb-status">Loading…</div>
      ) : files.length === 0 && folders.length === 0 ? (
        <div className="fb-status fb-empty">Nothing in this folder can be opened with the shared key.</div>
      ) : (
        <ul className="shared-list">
          {folders.map((folder) => (
            <li key={folder.id} className="shared-row">
              <button
                type="button"
                className="shared-meta shared-open"
                onClick={() => openSubfolder(folder.id, folder.name)}
              >
                <span className="fb-icon" aria-hidden="true">📁</span>
                {folder.name}
              </button>
            </li>
          ))}
          {files.map((file) => (
            <li key={file.id} className="shared-row">
              <span className="shared-meta">
                <span className="fb-icon" aria-hidden="true">{getFileIcon(file.mime_type)}</span>
                {file.name}
                <span className="shared-from">{formatFileSize(file.size)}</span>
              </span>
              <button
                type="button"
                className="selection-btn"
                disabled={busyFileId === file.id}
                onClick={() => void onDownload(file)}
              >
                Download
              </button>
            </li>
          ))}
        </ul>
      )}
      {snap && snap.unreadable.length > 0 && (
        <div className="fb-status">
          {snap.unreadable.length} item{snap.unreadable.length === 1 ? '' : 's'} in this folder could not be read with
          the shared key.
        </div>
      )}
    </div>
  )
}
