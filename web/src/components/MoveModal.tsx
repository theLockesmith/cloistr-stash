// Move-to-folder picker (ported from moveFileToFolder UX) using @cloistr/ui
// Modal. Lists the full folder tree (flat) plus root.
//
// Reused as the "Copy to folder" picker via the optional `title` prop.

import { Modal } from '@cloistr/ui/components'
import { useStash } from '../state/useStash'

export function MoveModal({
  open,
  onClose,
  onMove,
  title = 'Move to folder',
}: {
  open: boolean
  onClose: () => void
  onMove: (targetFolderId: string) => void
  title?: string
}) {
  const { folderTreeData } = useStash()

  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="sm">
      <ul className="move-list">
        <li>
          <button type="button" className="move-target" onClick={() => onMove('')}>
            📁 My Stash (root)
          </button>
        </li>
        {folderTreeData.map((folder) => (
          <li key={folder.id}>
            <button type="button" className="move-target" onClick={() => onMove(folder.id)}>
              📁 {folder.name}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
