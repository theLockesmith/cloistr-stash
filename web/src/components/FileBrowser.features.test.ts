/**
 * Structural guard: FileBrowser wires tags, sort/filter, copy, and folder upload.
 *
 * Same approach as FileBrowser.contextmenu.test.ts: no DOM environment, so we
 * assert wiring exists in source rather than rendering the component.
 *
 * SOURCE TEST, NOT A RENDER TEST. See FileBrowser.contextmenu.test.ts for the
 * rationale. Each test states exactly what structural claim it verifies.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'FileBrowser.tsx'), 'utf8')
const PROVIDER = readFileSync(join(__dirname, '../state/StashProvider.tsx'), 'utf8')
const OPERATIONS = readFileSync(join(__dirname, '../lib/operations.ts'), 'utf8')
const EVENTS = readFileSync(join(__dirname, '../lib/events.ts'), 'utf8')
const SHARE_MODAL = readFileSync(join(__dirname, 'ShareModal.tsx'), 'utf8')
const APP = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
const MOVE_MODAL = readFileSync(join(__dirname, 'MoveModal.tsx'), 'utf8')

describe('Tags feature', () => {
  it('file menu includes Tags… action', () => {
    const menuFn = SOURCE.slice(
      SOURCE.indexOf('const fileMenuItems'),
      SOURCE.indexOf('const folderMenuItems'),
    )
    expect(menuFn, "'Tags…' missing from file menu").toContain("'Tags…'")
  })

  it('TagsModal is defined in FileBrowser.tsx', () => {
    expect(SOURCE, 'TagsModal not defined').toContain('function TagsModal(')
  })

  it('TagsModal is used in FileBrowser modals block', () => {
    expect(SOURCE, 'TagsModal not rendered').toContain('<TagsModal')
  })

  it('operations.ts exports setFileTags', () => {
    expect(OPERATIONS, 'setFileTags not exported').toMatch(/export async function setFileTags/)
  })

  it('events.ts userTags property in EncryptedFileMetadataInput', () => {
    expect(EVENTS, 'userTags not in EncryptedFileMetadataInput').toContain('userTags')
  })

  it('events.ts emits t-tags for each userTag', () => {
    expect(EVENTS, "events.ts does not push 't' tags").toContain("['t', t.trim()")
  })
})

describe('Sort and filter controls', () => {
  it('sort field selector is present', () => {
    expect(SOURCE, 'sort select missing').toContain('fb-sort-select')
  })

  it('sort direction button is present', () => {
    expect(SOURCE, 'sort dir button missing').toContain('fb-sort-dir-btn')
  })

  it('tag filter selector is present', () => {
    expect(SOURCE, 'tag filter missing').toContain('fb-tag-filter')
  })

  it('sortPrefs is destructured from useStash', () => {
    expect(SOURCE, 'sortPrefs not destructured').toContain('sortPrefs,')
  })

  it('sortPrefs is persisted to localStorage in StashProvider', () => {
    expect(PROVIDER, 'sortPrefs not persisted').toContain("'stash:sortPrefs'")
  })

  it('useMemo applies tag filter before sort', () => {
    // tagFilteredFiles is computed from rawFiles and activeTagFilter
    expect(SOURCE, 'tag filter memo missing').toContain('tagFilteredFiles')
    expect(SOURCE, 'activeTagFilter not used in memo').toContain('activeTagFilter')
  })

  it('sort is applied on tagFilteredFiles', () => {
    expect(SOURCE, 'sort not applied after tag filter').toContain('tagFilteredFiles')
    expect(SOURCE, 'shownFiles not derived from sort').toContain('shownFiles = useMemo')
  })
})

describe('Copy file', () => {
  it('file menu includes Copy to… action', () => {
    const menuFn = SOURCE.slice(
      SOURCE.indexOf('const fileMenuItems'),
      SOURCE.indexOf('const folderMenuItems'),
    )
    expect(menuFn, "'Copy to…' missing from file menu").toContain("'Copy to…'")
  })

  it('CopyModal (MoveModal with copy title) is rendered in FileBrowser', () => {
    expect(SOURCE, 'Copy to folder MoveModal missing').toContain('Copy to folder')
  })

  it('copyFile is destructured from useStash in FileBrowser', () => {
    expect(SOURCE, 'copyFile not destructured').toContain('copyFile,')
  })
})

describe('Folder upload with directory traversal', () => {
  it('uploadDirectory is declared in StashProvider interface', () => {
    expect(PROVIDER, 'uploadDirectory not in interface').toContain('uploadDirectory:')
  })

  it('uploadDirectory uses FileSystem API recursion', () => {
    const fnBlock = PROVIDER.slice(PROVIDER.indexOf('const uploadDirectory'))
    expect(fnBlock, 'isDirectory not checked').toContain('isDirectory')
    expect(fnBlock, 'isFile not checked').toContain('isFile')
    expect(fnBlock, 'createFolderIn not called').toContain('createFolderIn')
  })

  it('App.tsx calls uploadDirectory on directory drop', () => {
    expect(APP, 'uploadDirectory not called on drop').toContain('void uploadDirectory(entries)')
  })

  it('App.tsx no longer shows the "not supported" notice', () => {
    expect(APP, 'old "not supported" notice still present').not.toContain(
      'Folder upload is not yet supported',
    )
  })
})

describe('Sharing links with expiry', () => {
  it('ShareModal has an expiry selector', () => {
    expect(SHARE_MODAL, 'expiry selector missing').toContain('share-expiry')
  })

  it('ShareModal passes expiresAt to Sharing.shareFile', () => {
    expect(SHARE_MODAL, 'expiresAt not passed to shareFile').toContain('expiresAt')
  })

  it('ShareModal passes expiresAt to generatePublicLink', () => {
    expect(SHARE_MODAL, 'expiresAt not passed to generatePublicLink').toContain(
      'Sharing.generatePublicLink(file, window.location.origin, { expiresAt })',
    )
  })

  it('expiry presets include 7 days and 30 days', () => {
    expect(SHARE_MODAL, '7-day preset missing').toContain("'7 days'")
    expect(SHARE_MODAL, '30-day preset missing').toContain("'30 days'")
  })
})

describe('MoveModal optional title prop', () => {
  it('MoveModal accepts an optional title prop', () => {
    expect(MOVE_MODAL, 'title prop missing').toContain("title = 'Move to folder'")
  })

  it('MoveModal passes title to Modal component', () => {
    expect(MOVE_MODAL, 'title not forwarded to Modal').toContain('title={title}')
  })
})

describe('Mobile: long-press for context menu', () => {
  it('useLongPress hook is defined in FileBrowser.tsx', () => {
    expect(SOURCE, 'useLongPress not defined').toContain('function useLongPress(')
  })

  it('useLongPress fires after 500ms', () => {
    expect(SOURCE, '500ms threshold missing').toContain('500')
  })

  it('FolderRow spreads long-press handlers', () => {
    const folderRow = SOURCE.slice(SOURCE.indexOf('function FolderRow('))
    expect(folderRow.slice(0, 1000), 'FolderRow missing ...lp spread').toContain('{...lp}')
  })

  it('FileRow spreads long-press handlers', () => {
    const fileRow = SOURCE.slice(SOURCE.indexOf('function FileRow('))
    expect(fileRow.slice(0, 1000), 'FileRow missing ...lp spread').toContain('{...lp}')
  })

  it('FolderCard spreads long-press handlers', () => {
    const folderCard = SOURCE.slice(SOURCE.indexOf('function FolderCard('))
    expect(folderCard.slice(0, 800), 'FolderCard missing ...lp spread').toContain('{...lp}')
  })

  it('FileCard spreads long-press handlers', () => {
    const fileCard = SOURCE.slice(SOURCE.indexOf('function FileCard('))
    expect(fileCard.slice(0, 800), 'FileCard missing ...lp spread').toContain('{...lp}')
  })
})
