import { describe, it, expect, afterEach, vi } from 'vitest'

// serviceConfig captures its values at import (as every consumer module does),
// so each case stubs the runtime global and then imports a fresh copy.
async function load(runtime?: Record<string, string>) {
  vi.resetModules()
  if (runtime) vi.stubGlobal('window', { __CLOISTR_CONFIG__: runtime, location: { origin: 'http://localhost:8081' } })
  return import('./serviceConfig')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('serviceConfig', () => {
  it('resolves to production when the container supplied nothing', async () => {
    const c = await load()
    expect(c.RELAY_URL).toBe('wss://relay.cloistr.xyz')
    expect(c.SIGNER_URL).toBe('https://signer.cloistr.xyz')
    expect(c.DISCOVERY_URL).toBe('https://discover.cloistr.xyz')
    // Stash's public blob host, not the shared reader's generic default.
    expect(c.BLOB_HOST).toBe('https://blossom.cloistr.xyz')
    expect(c.ENVIRONMENT).toBe('production')
  })

  it('uses the runtime configuration the container wrote', async () => {
    const c = await load({
      relayUrl: 'wss://relay.staging.cloistr.xyz',
      signerUrl: 'https://signer.staging.cloistr.xyz',
      discoveryUrl: 'https://discover.staging.cloistr.xyz',
      blossomUrl: 'https://blossom.staging.cloistr.xyz',
      appUrl: 'https://stash.staging.cloistr.xyz',
      environment: 'staging',
    })
    expect(c.RELAY_URL).toBe('wss://relay.staging.cloistr.xyz')
    expect(c.SIGNER_URL).toBe('https://signer.staging.cloistr.xyz')
    expect(c.DISCOVERY_URL).toBe('https://discover.staging.cloistr.xyz')
    expect(c.BLOB_HOST).toBe('https://blossom.staging.cloistr.xyz')
    expect(c.ENVIRONMENT).toBe('staging')
  })

  it('feeds the modules that talk to services', async () => {
    await load({
      relayUrl: 'wss://relay.staging.cloistr.xyz',
      discoveryUrl: 'https://discover.staging.cloistr.xyz',
      blossomUrl: 'https://blossom.staging.cloistr.xyz',
    })
    const { Relay } = await import('./relay')
    const { RelayPrefs } = await import('./relayprefs')
    const { PUBLIC_BLOB_HOST } = await import('./publish')
    expect(Relay.defaultUrl).toBe('wss://relay.staging.cloistr.xyz')
    expect(RelayPrefs.DEFAULT_RELAY).toBe('wss://relay.staging.cloistr.xyz')
    expect(RelayPrefs.DISCOVERY_URL).toBe('https://discover.staging.cloistr.xyz')
    expect(PUBLIC_BLOB_HOST).toBe('https://blossom.staging.cloistr.xyz')
  })
})
