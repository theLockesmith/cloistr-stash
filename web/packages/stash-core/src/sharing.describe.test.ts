// Share notifications (found live 2026-10-19) named every shared file
// "Unknown": the name is inside the share's encrypted content, and the poller
// never decrypted it. describeIncomingShare reads it for a new share.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./keys', () => ({
  Keys: {
    selfDecrypt: vi.fn(async (_pk: string, ct: string) => {
      if (!ct.startsWith('enc:')) throw new Error('cannot decrypt')
      return ct.slice(4)
    }),
  },
}))
vi.mock('./relay', () => ({ Relay: { subscribe: vi.fn(async () => []) } }))
vi.mock('./api', () => ({ API: {} }))
vi.mock('./upload', () => ({ addWrappedKeyToFolder: vi.fn() }))
vi.mock('./authBridge', () => ({ authPort: { isConnected: true, pubkey: 'me' }, getSigner: () => null }))

import { Sharing } from './sharing'

const share = (content: unknown) => ({ id: 's1', owner_pubkey: 'a'.repeat(64), encrypted_content: `enc:${JSON.stringify(content)}` })

describe('describeIncomingShare', () => {
  it('names a shared file from its decrypted content', async () => {
    expect(await Sharing.describeIncomingShare(share({ type: 'file', fileName: 'report.pdf' }))).toEqual({
      name: 'report.pdf',
      isFolder: false,
    })
  })

  it('names a shared folder and marks it a folder', async () => {
    expect(await Sharing.describeIncomingShare(share({ type: 'folder', folderName: 'Photos' }))).toEqual({
      name: 'Photos',
      isFolder: true,
    })
  })

  it('an undecryptable share is still reported, without a name', async () => {
    const result = await Sharing.describeIncomingShare({ id: 's2', owner_pubkey: 'b', encrypted_content: 'garbage' })
    expect(result).toEqual({ name: null, isFolder: false })
  })
})

describe('the notification poller uses it', () => {
  it('names each new share from its content', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const provider = readFileSync(join(__dirname, '../../../src/state/StashProvider.tsx'), 'utf8')
    const poll = provider.slice(provider.indexOf('const checkForNewShares'), provider.indexOf('applyNotifications([...newNotifications'))
    expect(poll).toContain('encrypted_content: s.encrypted_content')
    expect(poll).toMatch(/if \(existingIds\.has\(share\.id\)\) continue[\s\S]{0,300}Sharing\.describeIncomingShare\(/)
  })
})
