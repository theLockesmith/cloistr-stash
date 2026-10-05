// Compile-time guarantee that @cloistr/auth/core's SignerInterface plugs into
// the data layer's signer port. If @cloistr/auth changes the interface in an
// incompatible way, `tsc` fails here rather than at runtime in a client.
import { describe, it, expect } from 'vitest'
import type { SignerInterface } from '@cloistr/auth/core'
import type { Signer } from './authBridge'

const asPort = (s: SignerInterface): Signer => s

describe('SignerInterface -> Signer port', () => {
  it('is structurally assignable', () => {
    expect(typeof asPort).toBe('function')
  })
})
