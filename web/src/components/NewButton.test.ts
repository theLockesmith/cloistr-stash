import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NewButton } from './NewButton'

// docs/sheets/slides/whiteboard are leaving production: Stash must not offer
// to create them or link to their hosts.
const RETIRED_HOSTS = [
  'docs.cloistr.xyz',
  'sheets.cloistr.xyz',
  'slides.cloistr.xyz',
  'whiteboard.cloistr.xyz',
]

describe('NewButton', () => {
  const html = renderToStaticMarkup(createElement(NewButton, { onNewFolder: () => {} }))

  it('still offers a new folder', () => {
    expect(html).toContain('id="new-btn"')
    expect(html).toContain('data-type="folder"')
  })

  it('offers none of the retired collaborative document types', () => {
    for (const type of ['doc', 'sheet', 'whiteboard', 'slides']) {
      expect(html).not.toContain(`data-type="${type}"`)
    }
  })
})

describe('app source', () => {
  it('references none of the retired app hosts', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(p, 'utf8')
          for (const host of RETIRED_HOSTS) if (text.includes(host)) offenders.push(`${p}: ${host}`)
        }
      }
    }
    walk(src)
    expect(offenders).toEqual([])
  })
})
