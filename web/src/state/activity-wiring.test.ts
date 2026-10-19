// Activity Log (STASH-27, found live 2026-10-19): the log said "No activity
// recorded" after uploads, a rename, a move, a comment and downloads. The port
// brought the log over (stash-core activity.ts) but none of the calls that
// write to it. Each action the legacy app logged now logs on success.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const PROVIDER = read('StashProvider.tsx')

/** The body of `const <name> = useCallback(` up to the next top-level const. */
function callback(name: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const end = PROVIDER.indexOf('\n  const ', start + 1)
  return PROVIDER.slice(start, end)
}

describe('every logged action writes to the activity log', () => {
  it.each([
    ['uploadFiles', 'upload'],
    ['createFolder', 'folder'],
    ['renameFile', 'rename'],
    ['renameFolder', 'folder_rename'],
    ['deleteFile', 'delete'],
    ['moveFile', 'move'],
  ])('%s logs %s', (fn, type) => {
    expect(callback(fn)).toContain(`logActivity('${type}'`)
  })

  it.each([
    ['../components/FileInfoModal.tsx', 'download'],
    ['../components/KeyboardShortcuts.tsx', 'download'],
    ['../components/ShareModal.tsx', 'share'],
    ['../components/CommentsModal.tsx', 'comment'],
  ])('%s logs %s', (file, type) => {
    expect(read(file)).toContain(`logActivity('${type}'`)
  })
})
