import { workboxOptions } from '../../vite.config'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EmbedView, type EmbedState, type EmbedViewProps } from './EmbedView'
import { folderPath } from './EmbedApp'
import type { DriveSnapshot } from '@cloistr/stash-core/drive'

const noop = () => {}
const render = (state: EmbedState, extra: Partial<EmbedViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(EmbedView, {
      state,
      mode: 'browse',
      appUrl: 'https://stash.cloistr.xyz',
      selected: new Set<string>(),
      onOpenFolder: noop,
      onToggleFile: noop,
      onChoose: noop,
      onCancel: noop,
      onRetry: noop,
      ...extra,
    }),
  )

const list: EmbedState = {
  kind: 'list',
  path: [{ id: 'f1', name: 'Taxes' }],
  folders: [{ id: 'f2', name: '2026' }],
  files: [{ sha256: 'a'.repeat(64), name: 'return.pdf', size: 2048 }],
  unreadable: 0,
}

describe('EmbedView', () => {
  it('a refused embed shows no files and points to Stash', () => {
    const html = render({ kind: 'refused', reason: 'parent-not-allowed' })
    expect(html).toContain('only works inside Cloistr apps it trusts')
    expect(html).toContain('href="https://stash.cloistr.xyz"')
    expect(html).not.toContain('stash-embed__list')
  })

  it('signed out offers sign-in in a new tab, not inside the frame', () => {
    const html = render({ kind: 'signed-out' })
    expect(html).toContain('Sign in to Stash')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('lists folders and files with the path', () => {
    const html = render(list)
    expect(html).toContain('Taxes')
    expect(html).toContain('2026')
    expect(html).toContain('return.pdf')
    expect(html).not.toContain('type="checkbox"')
  })

  it('pick mode offers a checkbox per file and a Choose button, disabled until something is picked', () => {
    const none = render(list, { mode: 'pick' })
    expect(none).toContain('type="checkbox"')
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Choose<\/button>/)
    const one = render(list, { mode: 'pick', selected: new Set(['a'.repeat(64)]) })
    expect(one).toContain('Choose 1')
    expect(one).toContain('checked=""')
  })

  it('says how many items it could not open, never hides them', () => {
    expect(render({ ...list, unreadable: 3 } as EmbedState)).toContain('3 items could not be opened here')
  })

  it('an error says so and offers a retry', () => {
    const html = render({ kind: 'error', message: 'relay down' })
    expect(html).toContain('relay down')
    expect(html).toContain('Try again')
  })
})

describe('folderPath', () => {
  const drive = {
    folders: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', parent_id: 'a' },
      { id: 'x', name: 'X', parent_id: 'y' },
      { id: 'y', name: 'Y', parent_id: 'x' },
    ],
  } as unknown as DriveSnapshot

  it('walks from the root down', () => {
    expect(folderPath(drive, 'b')).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ])
    expect(folderPath(drive, '')).toEqual([])
  })

  it('stops on a cycle instead of looping', () => {
    expect(folderPath(drive, 'x').length).toBe(2)
  })
})

describe('embed source guards', () => {
  const dir = __dirname
  const sources = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const)

  it('never posts to any origin ("*")', () => {
    for (const [f, src] of sources) {
      expect(src, f).not.toMatch(/postMessage\([^)]*['"`]\*['"`]/)
    }
  })

  it('posts only through postToParent', () => {
    for (const [f, src] of sources) {
      const calls = src.match(/\.postMessage\(/g) ?? []
      expect(calls.length, f).toBe(f === 'protocol.ts' ? 1 : 0)
    }
  })

  it('has no inbound message handler', () => {
    for (const [f, src] of sources) {
      expect(src, f).not.toMatch(/addEventListener\(\s*['"]message['"]|onmessage/)
    }
  })

  it('checks the parent before starting sign-in', () => {
    const root = readFileSync(join(dir, 'EmbedRoot.tsx'), 'utf8')
    const body = root.slice(root.indexOf('export default function'))
    expect(body.indexOf('checkParent(')).toBeGreaterThan(-1)
    expect(body.indexOf('if (!check.ok)')).toBeLessThan(body.indexOf('<SharedAuthProvider'))
  })

  it.each(['/embed', '/embed/', '/embed/files', '/embed/files?parent=x'])(
    'the service worker never answers the navigation %s',
    (path) => {
      expect(workboxOptions.navigateFallbackDenylist.some((re) => re.test(path))).toBe(true)
    },
  )

  it('the main app is still answered offline', () => {
    expect(workboxOptions.navigateFallbackDenylist.some((re) => re.test('/embedded-folder'))).toBe(false)
  })
})
