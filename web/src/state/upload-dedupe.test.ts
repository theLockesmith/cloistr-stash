// Found live 2026-10-27: an upload reported failed had in fact landed, but the
// list on screen was loaded before it did, so the duplicate check (which only
// sees the list it is given) let a retry upload the same file a second time.
// The check must run against a fresh listing from the relay.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROVIDER = readFileSync(join(__dirname, 'StashProvider.tsx'), 'utf8')

function callback(name: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  return PROVIDER.slice(start, PROVIDER.indexOf('\n  const ', start + 1))
}

describe('upload duplicate check', () => {
  it('reads the current folder fresh from the relay, not the list on screen', () => {
    const body = callback('uploadFiles')
    const fetchAt = body.indexOf('fetchDrive(')
    const uploadAt = body.indexOf('libUploadFiles(')
    expect(fetchAt, 'uploadFiles never fetches the drive').toBeGreaterThan(-1)
    expect(fetchAt).toBeLessThan(uploadAt)
    expect(body).toContain('filesIn(')
  })
})
