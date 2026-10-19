// The Uploads panel (found live 2026-10-19) stayed on screen after every
// upload finished, had no close, and covered the row menus under it. It now
// has a close button and hides itself once every upload has succeeded;
// a failure stays until it is closed, so it cannot be missed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uploadsSettled } from './uploadPanel'

const BAR = readFileSync(join(__dirname, 'UploadBar.tsx'), 'utf8')
const PROVIDER = readFileSync(join(__dirname, '../state/StashProvider.tsx'), 'utf8')

const item = (status: string) => ({ status }) as never

describe('uploadsSettled', () => {
  it('is "done" only when every upload succeeded', () => {
    expect(uploadsSettled([item('success'), item('success')])).toBe('done')
  })
  it('is "attention" once all finished and one failed or was a duplicate', () => {
    expect(uploadsSettled([item('success'), item('error')])).toBe('attention')
    expect(uploadsSettled([item('duplicate')])).toBe('attention')
  })
  it('is "busy" while any upload is still running', () => {
    for (const s of ['pending', 'encrypting', 'hashing', 'uploading', 'publishing']) {
      expect(uploadsSettled([item('success'), item(s)])).toBe('busy')
    }
  })
})

describe('the panel can be closed', () => {
  it('the provider offers dismissUploads, clearing the list', () => {
    expect(PROVIDER).toMatch(/const dismissUploads = useCallback\(\(\) => setUploadItems\(\[\]\)/)
  })
  it('the panel has a Close button wired to it, and hides itself when all are done', () => {
    expect(BAR).toMatch(/aria-label="Close uploads"/)
    expect(BAR).toMatch(/onClick=\{dismissUploads\}/)
    expect(BAR).toMatch(/settled !== 'done'\) return[\s\S]{0,80}setTimeout\(dismissUploads/)
  })
})
