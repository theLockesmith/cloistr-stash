// cloistr-audit on !238: a revoke stopped partway by an account switch gave no
// sign in Manage Shares. The modal now says the re-encryption did not finish,
// what is still true (above all whether old shares still open the file), and
// offers Retry, which finishes it from where it stopped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { revokeStatus } from './revokeStatus'

const MODAL = readFileSync(join(__dirname, 'ManageSharesModal.tsx'), 'utf8')
const ME = 'a'.repeat(64)
const base = { pubkey: ME, fileId: 'f', oldSha256: 'b'.repeat(64) }

describe('an unfinished revoke never reads as done', () => {
  it('old copy still stored: says shared people can still open it, offers Retry', () => {
    const s = revokeStatus({ ...base, stage: 'old-copy-remains' }, ME)
    expect(s.text).toMatch(/did not finish/i)
    expect(s.text).toMatch(/can still open/i)
    expect(s.canRetry).toBe(true)
  })

  it('stopped before anything changed: says shares still work, offers Retry', () => {
    const s = revokeStatus({ ...base, stage: 'not-started' }, ME)
    expect(s.text).toMatch(/did not finish/i)
    expect(s.text).toMatch(/still work/i)
    expect(s.canRetry).toBe(true)
  })

  it('share records not withdrawn: says old shares no longer open it, offers Retry', () => {
    const s = revokeStatus({ ...base, stage: 'share-notices' }, ME)
    expect(s.text).toMatch(/did not finish/i)
    expect(s.text).toMatch(/no longer open/i)
    expect(s.canRetry).toBe(true)
  })

  it('old record still listed: says old shares no longer open it and the old entry is still listed, offers Retry', () => {
    const s = revokeStatus({ ...base, stage: 'old-record' }, ME)
    expect(s.text).toMatch(/did not finish/i)
    expect(s.text).toMatch(/no longer open/i)
    expect(s.text).toMatch(/old entry/i)
    expect(s.canRetry).toBe(true)
  })

  it('new copy possibly not saved: never claims it is saved, says old shares still open it', () => {
    const newEvent = { id: 'e', kind: 30078 } as never
    const s = revokeStatus({ ...base, stage: 'old-copy-remains', newEvent }, ME)
    expect(s.text).toMatch(/did not finish/i)
    expect(s.text).not.toMatch(/new copy is saved/i)
    expect(s.text).toMatch(/may not have been saved/i)
    expect(s.text).toMatch(/can still open/i)
    expect(s.canRetry).toBe(true)
  })

  it('signed in as another account: says which account to sign back in with, no Retry', () => {
    const s = revokeStatus({ ...base, stage: 'old-copy-remains' }, 'c'.repeat(64))
    expect(s.text).toMatch(/did not finish/i)
    expect(s.text).toMatch(/sign in/i)
    expect(s.text).toContain(ME.slice(0, 8))
    expect(s.canRetry).toBe(false)
  })

  it('the modal shows a kept unfinished revoke on open, catches it on failure, and retries it', () => {
    expect(MODAL).toMatch(/Sharing\.pendingRevoke\(/)
    expect(MODAL).toMatch(/instanceof RevokeIncompleteError/)
    expect(MODAL).toMatch(/Sharing\.retryRevoke\(file\)/)
    expect(MODAL).toMatch(/revokeStatus\(/)
    // Success wording only after a revoke that returned.
    const ok = MODAL.indexOf('All prior shares are invalid')
    expect(ok).toBeGreaterThan(MODAL.indexOf('await Sharing.revokeAndReencryptFile(file)'))
  })
})
