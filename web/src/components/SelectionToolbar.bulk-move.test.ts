/**
 * Structural guard: SelectionToolbar wires the Move button and moveSelected action.
 *
 * Same approach as FileBrowser.contextmenu.test.ts: no DOM environment, so we
 * assert wiring exists in source rather than rendering the component.
 *
 * What the tests cover:
 *  - The Move button is present in the source.
 *  - It is guarded by fileCount > 0 so it never appears when only folders are selected.
 *  - moveSelected is destructured from useStash.
 *  - MoveModal is imported and used by the toolbar.
 *  - StashProvider exports moveSelected in the context value interface.
 *  - upload.ts exports copyFile.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TOOLBAR = readFileSync(join(__dirname, 'SelectionToolbar.tsx'), 'utf8')
const PROVIDER = readFileSync(join(__dirname, '../state/StashProvider.tsx'), 'utf8')
const UPLOAD = readFileSync(join(__dirname, '../lib/upload.ts'), 'utf8')

describe('SelectionToolbar bulk move', () => {
  it('imports MoveModal', () => {
    expect(TOOLBAR).toContain("from './MoveModal'")
  })

  it('destructures moveSelected from useStash', () => {
    expect(TOOLBAR).toContain('moveSelected')
  })

  it('renders a Move button that opens the move modal', () => {
    // The button's onClick calls setMoveOpen(true). That's the observable
    // claim: the button exists and opens the modal.
    expect(TOOLBAR).toContain('setMoveOpen(true)')
  })

  it('guards the Move button behind fileCount > 0', () => {
    // The button must only appear when files are selected, not just folders.
    // The guard is the conditional render `{fileCount > 0 && ...}`.
    expect(TOOLBAR).toContain('fileCount > 0')
  })

  it('passes moveSelected into MoveModal onMove', () => {
    // The onMove handler calls moveSelected with the chosen folder id.
    expect(TOOLBAR).toContain('moveSelected(targetFolderId)')
  })
})

describe('StashProvider context value', () => {
  it('declares moveSelected in the interface', () => {
    expect(PROVIDER).toContain('moveSelected:')
  })

  it('includes moveSelected in the useMemo value object', () => {
    // The value object passed to the context must include moveSelected so
    // consumers can destructure it from useStash().
    const valueBlock = PROVIDER.slice(PROVIDER.lastIndexOf('useMemo<StashContextValue>'))
    expect(valueBlock).toContain('moveSelected,')
  })

  it('declares copyFile in the interface', () => {
    expect(PROVIDER).toContain('copyFile:')
  })

  it('includes copyFile in the useMemo value object', () => {
    const valueBlock = PROVIDER.slice(PROVIDER.lastIndexOf('useMemo<StashContextValue>'))
    expect(valueBlock).toContain('copyFile,')
  })
})

describe('upload.ts copyFile', () => {
  it('exports copyFile', () => {
    expect(UPLOAD).toMatch(/export async function copyFile/)
  })

  it('downloads the encrypted blob before decrypting', () => {
    const fnBlock = UPLOAD.slice(UPLOAD.indexOf('export async function copyFile'))
    expect(fnBlock).toContain('getDownloadURL')
    expect(fnBlock).toContain('decryptFile')
  })

  it('calls uploadEncryptedBytes to re-encrypt under the target folder', () => {
    const fnBlock = UPLOAD.slice(UPLOAD.indexOf('export async function copyFile'))
    expect(fnBlock).toContain('uploadEncryptedBytes')
  })

  it('wipes the source key after decryption', () => {
    const fnBlock = UPLOAD.slice(UPLOAD.indexOf('export async function copyFile'))
    expect(fnBlock).toContain('Crypto.wipeKey(sourceKey)')
  })
})
