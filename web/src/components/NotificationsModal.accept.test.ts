// Accept in the Notifications panel (found 2026-10-19) only marked the
// notification read and accepted; it never stored the share's key, so the
// share stayed unaccepted and its folder unreadable. It now runs the same
// accept path as the Shared view (Sharing.acceptShare via the provider) and
// marks the notification accepted only when that succeeded.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROVIDER = readFileSync(join(__dirname, '../state/StashProvider.tsx'), 'utf8')
const MODAL = readFileSync(join(__dirname, 'NotificationsModal.tsx'), 'utf8')

const fn = PROVIDER.slice(PROVIDER.indexOf('const acceptNotification = useCallback('), PROVIDER.indexOf('const declineNotification'))

describe('Notifications Accept stores the share key', () => {
  it('finds the share and runs the shared accept path', () => {
    expect(fn).toMatch(/Sharing\.listIncomingShares\(\)/)
    expect(fn).toMatch(/await acceptShare\(share\)/)
  })

  it('marks the notification accepted only after a successful accept', () => {
    const accepted = fn.indexOf('accepted: true')
    expect(accepted).toBeGreaterThan(fn.indexOf('await acceptShare(share)'))
    expect(fn).toMatch(/if \(!share[^)]*\) return false/)
  })

  it('the provider contract returns whether it worked, and the panel tells the user', () => {
    expect(PROVIDER).toMatch(/acceptNotification: \(id: string\) => Promise<boolean>/)
    expect(MODAL).toMatch(/success\(/)
    expect(MODAL).toMatch(/error\(/)
  })
})
