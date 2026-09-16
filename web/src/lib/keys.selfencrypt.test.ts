import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keys } from './keys'
import type { AuthPort } from './keys'

function mockAuth(overrides: Partial<AuthPort> = {}): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
    ...overrides,
  }
}

describe('Keys.selfEncrypt / selfDecrypt', () => {
  beforeEach(() => {
    Keys.nip44Writes = true
  })

  it('uses NIP-44 by default (nip44Writes=true)', async () => {
    const auth = mockAuth()
    Keys.configure({ auth })

    const ct = await Keys.selfEncrypt('recipient_pub', 'hello')
    expect(ct).toBe('nip44:hello')
    expect(auth.nip44Encrypt).toHaveBeenCalledWith('recipient_pub', 'hello')
    expect(auth.nip04Encrypt).not.toHaveBeenCalled()
  })

  it('falls back to NIP-04 when nip44Writes is disabled', async () => {
    Keys.nip44Writes = false
    const auth = mockAuth()
    Keys.configure({ auth })

    const ct = await Keys.selfEncrypt('recipient_pub', 'hello')
    expect(ct).toBe('nip04:hello')
    expect(auth.nip04Encrypt).toHaveBeenCalledWith('recipient_pub', 'hello')
  })

  it('falls back to NIP-04 when signer lacks NIP-44', async () => {
    const auth = mockAuth({ nip44Encrypt: undefined, nip44Decrypt: undefined })
    Keys.configure({ auth })

    const ct = await Keys.selfEncrypt('recipient_pub', 'hello')
    expect(ct).toBe('nip04:hello')
  })

  it('falls back to NIP-04 when NIP-44 encrypt throws', async () => {
    const auth = mockAuth({
      nip44Encrypt: vi.fn(async () => { throw new Error('signer:no-nip44') }),
    })
    Keys.configure({ auth })

    const ct = await Keys.selfEncrypt('recipient_pub', 'hello')
    expect(ct).toBe('nip04:hello')
  })

  it('selfDecrypt routes NIP-04 ciphertext (contains ?iv=) to nip04Decrypt', async () => {
    const auth = mockAuth()
    Keys.configure({ auth })

    const pt = await Keys.selfDecrypt('sender_pub', 'nip04:encrypted?iv=abc')
    expect(auth.nip04Decrypt).toHaveBeenCalledWith('sender_pub', 'nip04:encrypted?iv=abc')
    expect(auth.nip44Decrypt).not.toHaveBeenCalled()
    expect(pt).toBe('encrypted?iv=abc')
  })

  it('selfDecrypt routes NIP-44 ciphertext (no ?iv=) to nip44Decrypt', async () => {
    const auth = mockAuth()
    Keys.configure({ auth })

    const pt = await Keys.selfDecrypt('sender_pub', 'nip44:sealed_blob')
    expect(auth.nip44Decrypt).toHaveBeenCalledWith('sender_pub', 'nip44:sealed_blob')
    expect(pt).toBe('sealed_blob')
  })

  it('selfDecrypt falls back to NIP-04 when NIP-44 decrypt throws', async () => {
    const auth = mockAuth({
      nip44Decrypt: vi.fn(async () => { throw new Error('decrypt failed') }),
      nip04Decrypt: vi.fn(async (_pk, ct) => `fallback:${ct}`),
    })
    Keys.configure({ auth })

    const pt = await Keys.selfDecrypt('sender_pub', 'ambiguous_blob')
    expect(pt).toBe('fallback:ambiguous_blob')
  })
})

describe('Keys.isNip04Ciphertext', () => {
  it('detects NIP-04 by the ?iv= separator', () => {
    expect(Keys.isNip04Ciphertext('base64data?iv=base64iv')).toBe(true)
    expect(Keys.isNip04Ciphertext('pure_nip44_blob')).toBe(false)
    expect(Keys.isNip04Ciphertext('')).toBe(false)
  })
})
