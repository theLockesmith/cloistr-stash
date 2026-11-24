import { describe, expect, it, vi } from 'vitest'
import {
  EMBED_SOURCE,
  EMBED_VERSION,
  allowedParents,
  checkParent,
  isExactOrigin,
  postToParent,
  toPicked,
} from './protocol'

const SPACE = 'https://space.cloistr.xyz'
const allowed = [SPACE]
const framed = (search: string, ancestorOrigins?: string[] | null) =>
  checkParent({ search, framed: true, allowed, ancestorOrigins })

describe('allowedParents', () => {
  it('reads the space-separated list from /config.js', () => {
    expect(allowedParents({ embedParents: `${SPACE} https://space.staging.cloistr.xyz` })).toEqual([
      SPACE,
      'https://space.staging.cloistr.xyz',
    ])
  })

  it('drops anything that is not an exact origin, so a config cannot widen to a wildcard', () => {
    expect(allowedParents({ embedParents: `* https://*.cloistr.xyz ${SPACE}/ http://space.cloistr.xyz null` })).toEqual([])
  })

  it('is empty with no config, so the embed talks to no one', () => {
    expect(allowedParents(undefined)).toEqual([])
    expect(allowedParents({})).toEqual([])
    expect(allowedParents({ embedParents: ['x'] })).toEqual([])
  })

  it('allows plain http only on localhost', () => {
    expect(isExactOrigin('http://localhost:5173')).toBe(true)
    expect(isExactOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isExactOrigin('http://space.cloistr.xyz')).toBe(false)
  })
})

describe('checkParent', () => {
  it('accepts the exact allowed parent and reads the mode', () => {
    expect(framed(`?parent=${encodeURIComponent(SPACE)}`)).toEqual({ ok: true, parent: SPACE, mode: 'browse' })
    expect(framed(`?parent=${SPACE}&mode=pick`)).toEqual({ ok: true, parent: SPACE, mode: 'pick' })
  })

  it('refuses when not in a frame', () => {
    expect(checkParent({ search: `?parent=${SPACE}`, framed: false, allowed })).toEqual({ ok: false, reason: 'not-framed' })
  })

  it('refuses with no parent named', () => {
    expect(framed('')).toEqual({ ok: false, reason: 'no-parent' })
  })

  it.each([
    'https://space.cloistr.xyz/',
    'https://space.cloistr.xyz.evil.example',
    'https://evil.space.cloistr.xyz',
    'http://space.cloistr.xyz',
    'https://SPACE.cloistr.xyz',
    'https://space.cloistr.xyz:443',
    '*',
    'null',
  ])('refuses a parent that is not exactly allowed: %s', (p) => {
    expect(framed(`?parent=${encodeURIComponent(p)}`)).toEqual({ ok: false, reason: 'parent-not-allowed' })
  })

  it('refuses when the browser reports a different real parent', () => {
    expect(framed(`?parent=${SPACE}`, ['https://evil.example'])).toEqual({ ok: false, reason: 'parent-mismatch' })
  })

  it('accepts when the browser reports the same parent, or cannot report one', () => {
    expect(framed(`?parent=${SPACE}`, [SPACE]).ok).toBe(true)
    expect(framed(`?parent=${SPACE}`, []).ok).toBe(true)
    expect(framed(`?parent=${SPACE}`, null).ok).toBe(true)
  })
})

describe('toPicked', () => {
  it('passes only name, blob hash, size and type, never keys, ids or folders', () => {
    const picked = toPicked({
      sha256: 'ab'.repeat(32),
      id: 'file-id-secret',
      name: 'report.pdf',
      size: 1234,
      mime_type: 'application/pdf',
      folder: 'folder-id',
      folder_id: 'folder-id',
      owner_key: 'wrapped-key',
      fileKey: new Uint8Array(32),
      tags: ['tax'],
    })
    expect(picked).toEqual({ name: 'report.pdf', sha256: 'ab'.repeat(32), size: 1234, mimeType: 'application/pdf' })
    expect(Object.keys(picked).sort()).toEqual(['mimeType', 'name', 'sha256', 'size'])
  })

  it('reports unknown size and type as null', () => {
    expect(toPicked({ sha256: 'x', name: 'a' })).toEqual({ name: 'a', sha256: 'x', size: null, mimeType: null })
  })
})

describe('postToParent', () => {
  it('posts to the one checked origin, tagged with source and version', () => {
    const target = { postMessage: vi.fn() }
    postToParent(target, SPACE, { type: 'ready', signedIn: true })
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: 'ready', signedIn: true, source: EMBED_SOURCE, version: EMBED_VERSION },
      SPACE,
    )
  })
})
