// The shared Header switches account (or signer) with no sign-out between.
// Everything the key layer loaded belongs to the previous pubkey, so a switch
// must drop it and initialise for the new one (2026-10-09 cross-frontend sweep).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./migration-wrapped-keys', () => ({ runWrappedKeyMigration: async () => null }))

import { updateAuth, type Signer } from './authBridge'
import { Keys } from './keys'
import { Relay } from './relay'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const signer = () => ({}) as unknown as Signer

import type { MockInstance } from 'vitest'

let init: MockInstance<typeof Keys.init>
let clear: MockInstance<typeof Keys.clearCache>

beforeEach(async () => {
  await updateAuth(null, { isConnected: false, pubkey: null })
  init = vi.spyOn(Keys, 'init').mockImplementation(async (pk: string) => {
    Keys.userPubkey = pk
  })
  clear = vi.spyOn(Keys, 'clearCache')
  vi.spyOn(Relay, 'disconnect').mockImplementation(() => {})
  init.mockClear()
  clear.mockClear()
})

describe('updateAuth keyed on pubkey + signer', () => {
  it('a switch to another account with no sign-out re-initialises keys for the new account', async () => {
    await updateAuth(signer(), { isConnected: true, pubkey: A })
    Keys.keyCache.set('root', new Uint8Array(32).fill(1)) // account A's root key
    await updateAuth(signer(), { isConnected: true, pubkey: B })

    expect(init).toHaveBeenLastCalledWith(B)
    expect(clear).toHaveBeenCalled()
    expect(Keys.userPubkey).toBe(B)
    expect(Keys.keyCache.has('root')).toBe(false)
  })

  it('a new signer for the same account also re-initialises', async () => {
    await updateAuth(signer(), { isConnected: true, pubkey: A })
    await updateAuth(signer(), { isConnected: true, pubkey: A })
    expect(init).toHaveBeenCalledTimes(2)
  })

  it('the same signer and account does not re-initialise', async () => {
    const s = signer()
    await updateAuth(s, { isConnected: true, pubkey: A })
    await updateAuth(s, { isConnected: true, pubkey: A })
    expect(init).toHaveBeenCalledTimes(1)
    expect(clear).not.toHaveBeenCalled()
  })
})
