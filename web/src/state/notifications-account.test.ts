// cloistr-audit on !230: share notifications (decrypted share names and the
// sender's key prefix) sat in one localStorage entry, 'cloistr-notifications',
// shared by every account on the browser and never cleared. After a switch or a
// logout the next account saw the previous one's. They are now kept per
// account, the old shared entry is removed rather than handed to whoever signs
// in next, and a share check that finishes after a switch is dropped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_NOTIFICATIONS_KEY,
  findNewShareNotifications,
  loadNotifications,
  saveNotifications,
} from './notificationStore'
import type { StashNotification } from './types'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  keys() {
    return [...this.m.keys()]
  }
  dump() {
    return [...this.m.values()].join('\n')
  }
}

let store: MemoryStorage
beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})

const notif = (name: string): StashNotification => ({
  id: name,
  type: 'share_received',
  data: { shareId: `share-${name}`, name, from: 'cccccccc…' },
  timestamp: 1,
  read: false,
})

describe('notifications are kept per account', () => {
  it("after a switch, the next account does not see the previous account's", () => {
    saveNotifications(A, [notif('tax-return.pdf')])
    expect(loadNotifications(B)).toEqual([])
    expect(loadNotifications(A)).toEqual([notif('tax-return.pdf')])
  })

  it('signed out, nothing is loaded and nothing is saved', () => {
    saveNotifications(A, [notif('tax-return.pdf')])
    expect(loadNotifications(null)).toEqual([])
    saveNotifications(null, [notif('leak.txt')])
    expect(store.dump()).not.toContain('leak.txt')
  })

  it('the old shared entry is removed on load, never handed to whoever signs in', () => {
    store.setItem(LEGACY_NOTIFICATIONS_KEY, JSON.stringify([notif('previous-owner.pdf')]))
    expect(loadNotifications(B)).toEqual([])
    expect(store.getItem(LEGACY_NOTIFICATIONS_KEY)).toBeNull()
    expect(store.dump()).not.toContain('previous-owner.pdf')
  })

  it('the old shared entry is removed even when nobody is signed in', () => {
    store.setItem(LEGACY_NOTIFICATIONS_KEY, JSON.stringify([notif('previous-owner.pdf')]))
    loadNotifications(null)
    expect(store.getItem(LEGACY_NOTIFICATIONS_KEY)).toBeNull()
  })
})

describe('a share check that finishes after the account changed', () => {
  const share = { id: 'share-1', owner_pubkey: 'c'.repeat(64), encrypted_content: 'x' }

  it('is dropped when the switch lands while the share name is decrypted', () => {
    let current = A
    const out = findNewShareNotifications({
      pubkey: A,
      existingShareIds: new Set(),
      isCurrent: () => current === A,
      listShares: async () => [share],
      describe: async () => {
        current = B
        return { name: 'tax-return.pdf', isFolder: false }
      },
    })
    return expect(out).resolves.toBeNull()
  })

  it('is dropped when the switch lands while the shares are listed', () => {
    let current = A
    const out = findNewShareNotifications({
      pubkey: A,
      existingShareIds: new Set(),
      isCurrent: () => current === A,
      listShares: async () => {
        current = B
        return [share]
      },
      describe: async () => ({ name: 'tax-return.pdf', isFolder: false }),
    })
    return expect(out).resolves.toBeNull()
  })

  it('for the same account, new shares come back named, known ones skipped', async () => {
    const out = await findNewShareNotifications({
      pubkey: A,
      existingShareIds: new Set(['share-0']),
      isCurrent: () => true,
      listShares: async () => [{ ...share, id: 'share-0' }, share],
      describe: async () => ({ name: 'tax-return.pdf', isFolder: true }),
    })
    expect(out).toHaveLength(1)
    expect(out?.[0]).toMatchObject({ type: 'share_folder', data: { shareId: 'share-1', name: 'tax-return.pdf' } })
  })
})

// The provider's wiring, read from its source as account-switch.test.ts does.
const PROVIDER = readFileSync(join(__dirname, 'StashProvider.tsx'), 'utf8')
function callback(name: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  return PROVIDER.slice(start, PROVIDER.indexOf('\n  const ', start + 1))
}

describe('the provider holds one account’s notifications at a time', () => {
  it('never reads or writes the old shared entry itself', () => {
    expect(PROVIDER).not.toMatch(/'cloistr-notifications'/)
    expect(PROVIDER).not.toMatch(/\bloadStoredNotifications\(\)/)
  })

  it('reloads the list for the signed-in account, and empties it on sign-out or switch', () => {
    expect(PROVIDER).toMatch(/useNostrAuth\(\)/)
    const effect = PROVIDER.slice(PROVIDER.indexOf('// Notifications belong to one account'))
    expect(effect).toMatch(/loadNotifications\(account\)/)
    expect(effect).toMatch(/setSharedItems\(\[\]\)/)
  })

  it('a share check writes only if the account is still the one it checked for', () => {
    const body = callback('checkForNewShares')
    expect(body).toMatch(/isCurrent: \(\) => authPort\.pubkey === pubkey/)
    const guard = body.indexOf('notificationOwnerRef.current !== pubkey')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('applyNotifications('))
  })

  it('accepting a notification marks nothing once the account has changed', () => {
    const body = PROVIDER.slice(PROVIDER.indexOf('const acceptNotification = useCallback('), PROVIDER.indexOf('const declineNotification'))
    const mark = body.indexOf('setNotifications(')
    const listed = body.indexOf('await Sharing.listIncomingShares()')
    const accepted = body.indexOf('await acceptShare(share)')
    const after = (from: number) => body.indexOf('notificationOwnerRef.current !== owner', from)
    expect(after(listed)).toBeGreaterThan(listed)
    expect(after(listed)).toBeLessThan(accepted)
    expect(after(accepted)).toBeGreaterThan(accepted)
    expect(after(accepted)).toBeLessThan(mark)
  })

  it('the Shared view drops a listing that arrives after the account changed', () => {
    const body = callback('loadShared')
    const listed = body.indexOf('await Sharing.listIncomingShares()')
    const check = body.indexOf('authPort.pubkey !== pubkey', listed)
    expect(listed).toBeGreaterThan(-1)
    expect(check, 'no account check after the listing').toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('setSharedItems(', listed))
    expect(body.slice(body.indexOf('} catch'))).toMatch(/authPort\.pubkey !== pubkey[\s\S]*setError\(/)
  })
})
