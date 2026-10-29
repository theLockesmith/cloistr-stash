// Recent (STASH-12, found live 2026-10-19): the view stayed empty after
// uploads. Recent lists files you touched on this device; it counted only
// opening a file's info, so a file you had just uploaded, or previewed from
// its menu, was never in it. Uploads and previews now count too.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withAccess, RECENT_LIMIT } from './recent'

const PROVIDER = readFileSync(join(__dirname, 'StashProvider.tsx'), 'utf8')
const BROWSER = readFileSync(join(__dirname, '../components/FileBrowser.tsx'), 'utf8')
const UPLOAD = readFileSync(join(__dirname, '../../packages/stash-core/src/upload.ts'), 'utf8')

describe('withAccess', () => {
  it('puts the touched files first, newest first, without duplicates', () => {
    const before = [{ sha256: 'a', accessedAt: 1 }, { sha256: 'b', accessedAt: 2 }]
    expect(withAccess(before, ['b', 'c'], 10)).toEqual([
      { sha256: 'b', accessedAt: 10 },
      { sha256: 'c', accessedAt: 10 },
      { sha256: 'a', accessedAt: 1 },
    ])
  })

  it(`keeps at most ${RECENT_LIMIT} entries`, () => {
    const many = Array.from({ length: RECENT_LIMIT }, (_, i) => ({ sha256: `f${i}`, accessedAt: i }))
    const next = withAccess(many, ['new'], 999)
    expect(next).toHaveLength(RECENT_LIMIT)
    expect(next[0].sha256).toBe('new')
  })

  it('ignores missing hashes', () => {
    expect(withAccess([], ['', undefined as unknown as string], 1)).toEqual([])
  })
})

describe('what counts as touching a file', () => {
  it('an upload reports the stored blob hash of each file', () => {
    expect(UPLOAD).toMatch(/item\.sha256 = sha256/)
  })

  it('the provider records every successful upload as recent', () => {
    const fn = PROVIDER.slice(PROVIDER.indexOf('const uploadFiles = useCallback'), PROVIDER.indexOf('const runSearch'))
    expect(fn).toMatch(/recordFilesAccess\(/)
    expect(fn).toMatch(/status === 'success'/)
  })

  it('previewing from a file menu records it, as opening Info does', () => {
    expect(BROWSER).not.toMatch(/label: 'Preview', onClick: \(\) => setPreviewFile\(file\)/)
    expect(BROWSER).toMatch(/const openPreview = \(file: StashFile\) => \{\s*recordFileAccess\(file\.sha256\)/)
  })
})
