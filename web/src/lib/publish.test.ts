import { describe, it, expect } from 'vitest'
import { mergeProfilePicture, publicBlobUrl, publicUrlForFile, checkPublished, PUBLIC_BLOB_HOST } from './publish'
import type { ProfileRead } from './publish'

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

describe('readProfile / setProfilePicture — absent vs unreadable', () => {
  // The operator hit this: "Use as Nostr profile picture" refused with
  // "Could not read your current Nostr profile". Verified 2026-08-25 that
  // neither their pubkey nor the test account has ANY kind-0 on
  // relay.cloistr.xyz — so there was nothing to overwrite and the refusal was
  // wrong. readProfile returned null for both "none exists" and "query
  // failed", and the guard could not tell them apart.
  it('an absent profile is not the same as an unreadable one', () => {
    const absent: ProfileRead = { status: 'absent' }
    const unreadable: ProfileRead = { status: 'unreadable', reason: 'relay timeout' }
    expect(absent.status).not.toBe(unreadable.status)
  })

  it('merges into nothing when the profile is absent, without discarding the picture', () => {
    // The safe-create case: no existing fields to lose.
    const merged = mergeProfilePicture('', 'https://blossom.cloistr.xyz/abc')
    expect(JSON.parse(merged).picture).toBe('https://blossom.cloistr.xyz/abc')
  })

  it('preserves existing fields when a profile IS found', () => {
    // The case the guard exists to protect: name/about must survive.
    const existing = JSON.stringify({ name: 'ccoleman', about: 'builder', nip05: 'a@b.c' })
    const merged = JSON.parse(mergeProfilePicture(existing, 'https://blossom.cloistr.xyz/xyz'))
    expect(merged.name).toBe('ccoleman')
    expect(merged.about).toBe('builder')
    expect(merged.nip05).toBe('a@b.c')
    expect(merged.picture).toBe('https://blossom.cloistr.xyz/xyz')
  })
})

describe('publicUrlForFile / checkPublished', () => {
  // The operator asked: once a file has been shared publicly, how do I get the
  // link again WITHOUT re-running the whole "Share publicly" flow? Previously
  // you could not — nothing surfaced it, and FileInfoModal even carries a note
  // saying Public Link "does not exist in the React codebase".
  //
  // Nothing new needs storing: publishing keys the blob by the hash of the
  // PLAINTEXT bytes, and that hash is already on the file's metadata as the
  // `ox` tag, written at upload.
  it('derives the URL from the stored plaintext hash', () => {
    const file = { sha256: 'encrypted-hash', name: 'cat.png', plaintext_hash: 'abc123' }
    expect(publicUrlForFile(file as never)).toBe(`${PUBLIC_BLOB_HOST}/abc123`)
  })

  it('accepts the camelCase spelling too', () => {
    // Both spellings exist in the record; operations.ts reads either.
    const file = { sha256: 'x', name: 'y', plaintextHash: 'def456' }
    expect(publicUrlForFile(file as never)).toBe(`${PUBLIC_BLOB_HOST}/def456`)
  })

  it('returns null when there is no plaintext hash, rather than a broken URL', () => {
    // A URL built from undefined would 404 and look like a server fault.
    expect(publicUrlForFile({ sha256: 'x', name: 'y' } as never)).toBeNull()
  })

  it('does NOT use the encrypted sha256 — that blob is not the public one', () => {
    const file = { sha256: 'ENCRYPTED', name: 'y', plaintext_hash: 'PLAIN' }
    const url = publicUrlForFile(file as never)
    expect(url).toContain('PLAIN')
    expect(url).not.toContain('ENCRYPTED')
  })

  it('reports published on 200', async () => {
    const ok = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    expect(await checkPublished('u', ok)).toBe('published')
  })

  it('reports not-published on 404', async () => {
    const nf = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    expect(await checkPublished('u', nf)).toBe('not-published')
  })

  it('reports unknown on a network error, NOT not-published', async () => {
    // Showing "not published" for a network failure would tell the user their
    // file is private when it may well be public. Three states, not two.
    const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await checkPublished('u', boom)).toBe('unknown')
  })

  it('reports unknown on a 500, NOT not-published', async () => {
    const err = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    expect(await checkPublished('u', err)).toBe('unknown')
  })
})
