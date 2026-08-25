/**
 * AppShell migration guard.
 *
 * These tests verify that stash's AppShell migration is complete and cannot
 * quietly revert. Before the migration, stash rendered its own hamburger
 * (#mobile-menu-btn) outside the shared header, positioned in the content
 * area, with its own open/close state. After migration, AppShell owns the
 * single mobile affordance.
 *
 * What we check:
 *   1. The app-owned hamburger class is absent from App.tsx and index.css.
 *   2. AppShell is imported and used in App.tsx.
 *   3. buildStashMenu (the pure menu-data function) is exported and returns
 *      non-empty sections.
 *   4. Sidebar.tsx renders NO toggle of its own. It used to render
 *      #sidebar-toggle, so once the shared header control landed there were two
 *      hamburgers on desktop driving one state.
 *   5. .sidebar-overlay is absent from index.css — AppShell provides its
 *      own scrim; the app-level one is dead code.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(__dirname, '../index.css'), 'utf8')
const APP = readFileSync(join(__dirname, '../App.tsx'), 'utf8')

function splitCssSegments(src: string): { media: boolean; text: string }[] {
  const segments: { media: boolean; text: string }[] = []
  let i = 0
  while (i < src.length) {
    const mediaMatch = /^@media\b/.exec(src.slice(i))
    if (mediaMatch) {
      const start = i
      const openBrace = src.indexOf('{', i)
      if (openBrace === -1) break
      let depth = 1
      let j = openBrace + 1
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        j++
      }
      segments.push({ media: true, text: src.slice(start, j) })
      i = j
    } else {
      const nextMedia = src.indexOf('@media', i)
      const chunk = nextMedia === -1 ? src.slice(i) : src.slice(i, nextMedia)
      if (chunk.trim()) segments.push({ media: false, text: chunk })
      i = nextMedia === -1 ? src.length : nextMedia
    }
  }
  return segments
}

const segments = splitCssSegments(CSS)

function mobileMediaSegmentsFor(selector: string): string[] {
  return segments
    .filter((s) => s.media && /max-width/.test(s.text) && s.text.includes(selector))
    .map((s) => s.text)
}

describe('AppShell migration: app-owned hamburger removed', () => {
  it('App.tsx does not contain #mobile-menu-btn', () => {
    expect(APP, 'The app-owned hamburger was not removed from App.tsx').not.toContain('mobile-menu-btn')
  })

  it('index.css does not contain .mobile-menu-btn', () => {
    expect(CSS, '.mobile-menu-btn was not removed from index.css').not.toContain('.mobile-menu-btn')
  })

  it('App.tsx does not contain sidebar-overlay', () => {
    expect(APP, 'The app-level sidebar overlay was not removed from App.tsx').not.toContain('sidebar-overlay')
  })

  it('index.css does not contain .sidebar-overlay', () => {
    expect(CSS, '.sidebar-overlay was not removed from index.css').not.toContain('.sidebar-overlay')
  })
})

describe('AppShell migration: AppShell is in use', () => {
  it('App.tsx imports AppShell from @cloistr/ui/components', () => {
    expect(APP, 'AppShell import not found').toContain("AppShell")
    expect(APP, 'AppShell import must be from @cloistr/ui/components').toContain('@cloistr/ui/components')
  })

  it('App.tsx uses <AppShell serviceId="stash"', () => {
    expect(APP, '<AppShell serviceId="stash"> not found — shell is not active').toContain(
      'serviceId="stash"',
    )
  })

  it('App.tsx passes nav prop to AppShell', () => {
    expect(APP, 'nav prop not found on AppShell — sidebar nav will not appear in drawer').toContain('nav={')
  })

  it('App.tsx passes menu prop to AppShell', () => {
    expect(APP, 'menu prop not found on AppShell — commands will not appear in desktop bar or drawer').toContain('menu={')
  })
})

describe('AppShell migration: menu data is valid', () => {
  it('buildStashMenu returns at least one section', async () => {
    const { buildStashMenu } = await import('../App')
    const sections = buildStashMenu({
      view: 'my-files',
      onNewFolder: () => {},
      onBackup: () => {},
      onNotifications: () => {},
      onActivity: () => {},
    })
    expect(sections.length, 'buildStashMenu must return at least one section').toBeGreaterThan(0)
  })

  it('buildStashMenu: New Folder is enabled in my-files view', async () => {
    const { buildStashMenu } = await import('../App')
    const sections = buildStashMenu({
      view: 'my-files',
      onNewFolder: () => {},
      onBackup: () => {},
      onNotifications: () => {},
      onActivity: () => {},
    })
    const items = sections.flatMap((s) => s.items)
    const newFolderItem = items.find(
      (item) => !('separator' in item) && item.label === 'New Folder',
    )
    expect(newFolderItem, 'New Folder item not found').toBeDefined()
    expect('onSelect' in newFolderItem! && typeof (newFolderItem as {onSelect?: unknown}).onSelect, 'New Folder must have onSelect in my-files view').toBe('function')
  })

  it('buildStashMenu: New Folder is disabled outside my-files', async () => {
    const { buildStashMenu } = await import('../App')
    const sections = buildStashMenu({
      view: 'shared',
      onNewFolder: () => {},
      onBackup: () => {},
      onNotifications: () => {},
      onActivity: () => {},
    })
    const items = sections.flatMap((s) => s.items)
    const newFolderItem = items.find(
      (item) => !('separator' in item) && (item as {label: string}).label === 'New Folder',
    ) as {label: string; onSelect?: () => void; disabledReason?: string} | undefined
    expect(newFolderItem, 'New Folder item not found').toBeDefined()
    expect(newFolderItem!.onSelect, 'New Folder must be disabled (no onSelect) outside my-files').toBeUndefined()
    expect(newFolderItem!.disabledReason, 'Disabled New Folder must have a disabledReason').toBeTruthy()
  })
})

describe('AppShell migration: one collapse control, and it is the header\'s', () => {
  const SIDEBAR = readFileSync(join(__dirname, './Sidebar.tsx'), 'utf8')

  it('Sidebar.tsx renders no toggle button of its own', () => {
    // Asserting on the RENDERED markers, not the word "toggle": the file's
    // comment explains why the button is gone, and matching that comment would
    // fail for the wrong reason.
    expect(SIDEBAR, 'Sidebar must not render id="sidebar-toggle"').not.toMatch(/id="sidebar-toggle"/)
    expect(SIDEBAR, 'Sidebar must not render its own Toggle sidebar button').not.toMatch(
      /aria-label="Toggle sidebar"/,
    )
  })

  it('App.tsx places the single control in the header and drives its own state', () => {
    // Without `collapsed`/`onCollapsedChange`, AppShell keeps a SECOND collapse
    // state that stash's <Sidebar collapsed={...}> never reads — which is how
    // the desktop hamburger came to move but do nothing.
    expect(APP, 'AppShellToggle must be rendered').toMatch(/<AppShellToggle\s*\/>/)
    expect(APP, 'toggleInHeader must be set, or the trigger renders above the content').toMatch(
      /toggleInHeader/,
    )
    expect(APP, "AppShell must be told stash's collapsed state").toMatch(/collapsed=\{sidebarCollapsed\}/)
    expect(APP, 'AppShell must report collapse changes back').toMatch(/onCollapsedChange=/)
  })
})
