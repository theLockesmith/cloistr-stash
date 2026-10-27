// Found live 2026-10-27: after Delete, opening Trash showed "Trash is empty"
// and stayed that way, while the relay held the file with deleted_at; leaving
// Trash and coming back showed it. Every action ends by reloading the current
// view, but reloadCurrentView read `view` from the render the action started
// in (My Files), so a move to Trash that finished after the user opened Trash
// reloaded My Files and left Trash as it was before the record landed.
// The reload must go to the view on screen when the action finishes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROVIDER = readFileSync(join(__dirname, 'StashProvider.tsx'), 'utf8')

function callback(name: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  return PROVIDER.slice(start, PROVIDER.indexOf('\n  const ', start + 1))
}

describe('reloading after an action', () => {
  it('reloads the view on screen now, not the one the action started in', () => {
    const body = callback('reloadCurrentView')
    expect(body).toContain('viewRef.current')
    expect(body, 'still reads the captured view state').not.toMatch(/\bview ===/)
  })

  it('setView records the new view before it loads', () => {
    const body = callback('setView')
    const recordAt = body.indexOf('viewRef.current = next')
    expect(recordAt, 'setView never records the view').toBeGreaterThan(-1)
    expect(recordAt).toBeLessThan(body.indexOf('await '))
  })
})
