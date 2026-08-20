import { describe, it, expect } from 'vitest'
import { mergeProfilePicture, publicBlobUrl, PUBLIC_BLOB_HOST } from './publish'

describe('publicBlobUrl', () => {
  it('builds a plain hash URL with no fragment', () => {
    // The whole reason this feature exists: a Nostr client fetches `picture`
    // expecting raw bytes. A URL fragment is never sent to the server, so the
    // shared-link form (/public/{hash}#{key}) can never work here.
    const url = publicBlobUrl('abc123')
    expect(url).toBe('https://blossom.cloistr.xyz/abc123')
    expect(url).not.toContain('#')
    expect(url).not.toContain('/public/')
  })

  it('accepts an alternate host and normalises a trailing slash', () => {
    expect(publicBlobUrl('deadbeef', 'https://files.cloistr.xyz/')).toBe(
      'https://files.cloistr.xyz/deadbeef',
    )
  })

  it('defaults to the documented public host', () => {
    expect(PUBLIC_BLOB_HOST).toBe('https://blossom.cloistr.xyz')
  })
})

describe('mergeProfilePicture', () => {
  // A kind-0 REPLACES the previous one wholesale. Getting this wrong does not
  // fail loudly — it silently erases someone's public identity on every relay
  // that accepts the event.
  it('preserves every existing profile field', () => {
    const existing = JSON.stringify({
      name: 'ccoleman',
      about: 'Building Cloistr',
      nip05: 'ccoleman@cloistr.xyz',
      lud16: 'ccoleman@cloistr.xyz',
      banner: 'https://example.test/banner.png',
    })

    const merged = JSON.parse(mergeProfilePicture(existing, 'https://blossom.cloistr.xyz/abc'))

    expect(merged.name).toBe('ccoleman')
    expect(merged.about).toBe('Building Cloistr')
    expect(merged.nip05).toBe('ccoleman@cloistr.xyz')
    expect(merged.lud16).toBe('ccoleman@cloistr.xyz')
    expect(merged.banner).toBe('https://example.test/banner.png')
    expect(merged.picture).toBe('https://blossom.cloistr.xyz/abc')
  })

  it('keeps fields it does not know about', () => {
    // Nostr profiles carry arbitrary keys. Dropping unknown ones because we do
    // not recognise them is the same data loss, just less obvious.
    const existing = JSON.stringify({ name: 'x', some_future_field: { nested: true } })
    const merged = JSON.parse(mergeProfilePicture(existing, 'https://h/1'))
    expect(merged.some_future_field).toEqual({ nested: true })
  })

  it('replaces an existing picture rather than duplicating it', () => {
    const existing = JSON.stringify({ name: 'x', picture: 'https://old/pic.png' })
    const merged = JSON.parse(mergeProfilePicture(existing, 'https://new/pic.png'))
    expect(merged.picture).toBe('https://new/pic.png')
    expect(merged.name).toBe('x')
  })

  it('handles an empty profile', () => {
    expect(JSON.parse(mergeProfilePicture('', 'https://h/1'))).toEqual({ picture: 'https://h/1' })
    expect(JSON.parse(mergeProfilePicture('   ', 'https://h/1'))).toEqual({
      picture: 'https://h/1',
    })
  })

  it('refuses to overwrite content that is not a JSON object', () => {
    // Some clients put non-object content in kind-0. Blindly replacing it with
    // our own object would destroy whatever it was.
    expect(() => mergeProfilePicture('["not", "an", "object"]', 'https://h/1')).toThrow(
      /not a JSON object/,
    )
    expect(() => mergeProfilePicture('"just a string"', 'https://h/1')).toThrow(
      /not a JSON object/,
    )
    expect(() => mergeProfilePicture('null', 'https://h/1')).toThrow(/not a JSON object/)
  })

  it('propagates malformed JSON rather than silently starting fresh', () => {
    // Swallowing a parse error and writing a fresh profile is exactly the data
    // loss this module exists to avoid.
    expect(() => mergeProfilePicture('{ broken', 'https://h/1')).toThrow()
  })
})
