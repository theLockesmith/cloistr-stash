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
 *  - upload.ts copyFile downloads, decrypts, and re-encrypts.
 *
 * This is a SOURCE test, not a render test. It checks the wiring exists in the
 * source files, not that the UI behaves correctly at runtime. The limitation is
 * stated here rather than dressed up: a render test would be stronger, but the
 * package has no DOM environment (no jsdom/happy-dom, no @testing-library/react).
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
    expect(TOOLBAR).toContain('setMoveOpen(true)')
  })

  it('guards the Move button behind fileCount > 0', () => {
    expect(TOOLBAR).toContain('fileCount > 0')
  })

  it('passes moveSelected into MoveModal onMove', () => {
    expect(TOOLBAR).toContain('moveSelected(targetFolderId)')
  })
})

describe('StashProvider context value', () => {
  it('declares moveSelected in the interface', () => {
    expect(PROVIDER).toContain('moveSelected:')
  })

  it('includes moveSelected in the useMemo value object', () => {
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

  it('declares setFileTags in the interface', () => {
    expect(PROVIDER).toContain('setFileTags:')
  })

  it('declares uploadDirectory in the interface', () => {
    expect(PROVIDER).toContain('uploadDirectory:')
  })

  it('includes uploadDirectory in the useMemo value object', () => {
    const valueBlock = PROVIDER.slice(PROVIDER.lastIndexOf('useMemo<StashContextValue>'))
    expect(valueBlock).toContain('uploadDirectory,')
  })

  it('declares activeTagFilter in the interface', () => {
    expect(PROVIDER).toContain('activeTagFilter')
  })

  it('declares sortPrefs in the interface', () => {
    expect(PROVIDER).toContain('sortPrefs')
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