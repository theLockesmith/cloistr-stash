// File info modal (ported from app.js showFileInfo + the #file-info-modal
// markup) using @cloistr/ui Modal.

import { Modal } from '@cloistr/ui/components'
import type { StashFile } from '../state/types'
import { formatFileSize } from './format'

export function FileInfoModal({ file, onClose }: { file: StashFile | null; onClose: () => void }) {
  if (!file) return null

  const hash = file.sha256 || '-'
  const hashShort = hash.length > 24 ? `${hash.slice(0, 16)}...${hash.slice(-8)}` : hash
  const created = file.created_at ? new Date((file.created_at as number) * 1000).toLocaleString() : 'Unknown'
  const isEncrypted = file.encrypted !== false
  const type = (file.mime_type || (file.mimeType as string) || 'Unknown') as string

  return (
    <Modal isOpen={!!file} onClose={onClose} title="File info" size="sm">
      <dl className="file-info">
        <dt>Name</dt>
        <dd>{file.name}</dd>
        <dt>Size</dt>
        <dd>{formatFileSize(file.size)}</dd>
        <dt>Type</dt>
        <dd>{type}</dd>
        <dt>Created</dt>
        <dd>{created}</dd>
        <dt>Encrypted</dt>
        <dd>{isEncrypted ? 'Yes (E2E)' : 'No'}</dd>
        <dt>Hash</dt>
        <dd title={hash}>
          <code>{hashShort}</code>
        </dd>
      </dl>
    </Modal>
  )
}
