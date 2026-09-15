import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the relay module before importing Sharing.
const mockSubscribe = vi.fn()
vi.mock('./relay', () => ({
  Relay: { subscribe: (...args: unknown[]) => mockSubscribe(...args) },
}))

// Mock authPort so Sharing doesn't throw on module load.
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: 'abc123',
    signEvent: vi.fn(),
    publishEvent: vi.fn(),
    nip04Encrypt: vi.fn(),
    nip04Decrypt: vi.fn(),
    nip44Encrypt: vi.fn(),
    nip44Decrypt: vi.fn(),
  },
}))

// Mock keys to avoid IndexedDB access.
vi.mock('./keys', () => ({
  Keys: {
    selfEncrypt: vi.fn(async (_pk: string, pt: string) => 'enc:' + pt),
    selfDecrypt: vi.fn(async (_pk: string, ct: string) => ct.replace('enc:', '')),
  },
}))

// Mock API (fallback path).
const mockListShares = vi.fn()
vi.mock('./api', () => ({
  API: { listShares: (...args: unknown[]) => mockListShares(...args) },
}))

import { Sharing } from './sharing'

describe('queryIncomingSharesFromRelay', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('queries kind 30080 events addressed to the pubkey', async () => {
    mockSubscribe.mockResolvedValue([
      {
        id: 'evt1',
        pubkey: 'sender_abc',
        content: 'encrypted_payload_1',
        tags: [['d', 'share-001'], ['p', 'my_pubkey']],
      },
      {
        id: 'evt2',
        pubkey: 'sender_def',
        content: 'encrypted_payload_2',
        tags: [['d', 'share-002'], ['p', 'my_pubkey']],
      },
    ])

    const shares = await Sharing.queryIncomingSharesFromRelay('my_pubkey')

    expect(mockSubscribe).toHaveBeenCalledWith(
      { kinds: [30080], '#p': ['my_pubkey'] },
      10000,
    )
    expect(shares).toHaveLength(2)
    expect(shares[0]).toMatchObject({
      id: 'share-001',
      owner_pubkey: 'sender_abc',
      encrypted_content: 'encrypted_payload_1',
    })
    expect(shares[1]).toMatchObject({
      id: 'share-002',
      owner_pubkey: 'sender_def',
      encrypted_content: 'encrypted_payload_2',
    })
  })

  it('falls back to event.id when no d-tag is present', async () => {
    mockSubscribe.mockResolvedValue([
      {
        id: 'raw_event_id',
        pubkey: 'sender_abc',
        content: 'payload',
        tags: [['p', 'my_pubkey']],
      },
    ])

    const shares = await Sharing.queryIncomingSharesFromRelay('my_pubkey')
    expect(shares[0].id).toBe('raw_event_id')
  })
})

describe('listIncomingShares relay-first with API fallback', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('uses the relay as primary source', async () => {
    mockSubscribe.mockResolvedValue([
      {
        id: 'evt1',
        pubkey: 'sender_abc',
        content: 'enc:{"type":"file","fileKey":"enc:aabb","fileId":"f1","fileName":"test.txt","fileSHA256":"deadbeef","fileURL":"url","fileSize":100,"message":"","encrypted":true}',
        tags: [['d', 'share-001'], ['p', 'abc123']],
      },
    ])

    const result = await Sharing.listIncomingShares()

    expect(mockSubscribe).toHaveBeenCalled()
    expect(mockListShares).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0].decrypted).toBe(true)
  })

  it('falls back to API when relay fails', async () => {
    mockSubscribe.mockRejectedValue(new Error('Relay timeout'))
    mockListShares.mockResolvedValue({
      received: [
        {
          id: 'api-share-1',
          owner_pubkey: 'sender_abc',
          encrypted_content: 'enc:{"type":"file"}',
        },
      ],
    })

    const result = await Sharing.listIncomingShares()

    expect(mockSubscribe).toHaveBeenCalled()
    expect(mockListShares).toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('api-share-1')
  })

  it('returns empty when both relay and API fail', async () => {
    mockSubscribe.mockRejectedValue(new Error('Relay down'))
    mockListShares.mockRejectedValue(new Error('API down'))

    const result = await Sharing.listIncomingShares()
    expect(result).toEqual([])
  })
})
