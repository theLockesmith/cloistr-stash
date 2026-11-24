// A listing applied after the account changed shows the previous account's
// files. loadFilesFor waits on the relay; a switch during a slow load must
// leave the screen to the new account's load.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROVIDER = readFileSync(join(__dirname, 'StashProvider.tsx'), 'utf8')

function callback(name: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  return PROVIDER.slice(start, PROVIDER.indexOf('\n  const ', start + 1))
}

describe('loading files across an account switch', () => {
  const body = callback('loadFilesFor')
  // Every await before the listing reaches the screen; the account is checked after the last.
  const lastWait = body.lastIndexOf('await ', body.indexOf('setFolders('))
  const check = body.indexOf('authPort.pubkey !== pubkey', lastWait)

  it('checks the account is still the one it loaded for, after the last wait', () => {
    expect(check, 'no account check after the last await').toBeGreaterThan(-1)
  })

  it('makes that check before it shows the listing', () => {
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('setFolders('))
    expect(check).toBeLessThan(body.indexOf('setFiles('))
    expect(check).toBeLessThan(body.indexOf('setMigrationFiles('))
  })

  it("does not report the old account's failure on the new account's screen", () => {
    const failure = body.slice(body.indexOf('} catch'))
    expect(failure).toMatch(/authPort\.pubkey !== pubkey[\s\S]*setError\(/)
  })

  it('the starred, recent and trash views check the same before they show', () => {
    const special = callback('loadSpecialView')
    const at = special.indexOf('authPort.pubkey !== pubkey', special.lastIndexOf('await '))
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(special.indexOf('setSpecialFiles('))
    expect(special.slice(special.indexOf('} catch'))).toMatch(/authPort\.pubkey !== pubkey[\s\S]*setError\(/)
  })
})
