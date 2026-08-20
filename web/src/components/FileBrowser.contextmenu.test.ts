/**
 * Structural guard: every surface that renders a file or folder must wire a
 * context menu.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A RENDER TEST
 *
 * This package has vitest but no DOM environment (no jsdom/happy-dom, no
 * @testing-library/react), so FileBrowser cannot be mounted here. Adding those
 * is a dependency change governed by Renovate and out of scope for a UX fix.
 * A source assertion is weaker than a render test — it checks the wiring exists,
 * not that right-click opens a menu — and that limit is stated plainly rather
 * than dressed up.
 *
 * It is still worth having, because the bug it guards was PURELY structural.
 * Context menus were implemented and worked in list view, while grid view and
 * search results simply never passed onContextMenu. Grid-view files had no
 * actions at all: no kebab menu and no right-click, so the eleven items
 * available on the very same file in list view were unreachable. Nothing
 * failed; a whole view was just inert.
 *
 * That regression reappears the moment someone adds a fourth surface, and this
 * catches exactly that.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'FileBrowser.tsx'), 'utf8')

/** Every component that renders one file/folder and must be right-clickable. */
const SURFACES = ['FileRow', 'FolderRow', 'FileCard', 'FolderCard']

describe('FileBrowser context menus', () => {
  it.each(SURFACES)('%s accepts an onContextMenu prop', (component) => {
    // The component's own definition must declare the prop, otherwise a call
    // site passing it is silently ignored.
    const definition = SOURCE.slice(SOURCE.indexOf(`function ${component}(`))
    expect(definition.slice(0, 1200)).toContain('onContextMenu')
  })

  it.each(SURFACES)('every <%s> call site passes onContextMenu', (component) => {
    const callSites = [...SOURCE.matchAll(new RegExp(`<${component}\\b`, 'g'))]
    expect(callSites.length).toBeGreaterThan(0)

    for (const match of callSites) {
      // Slice to the element's closing `/>`; props are multi-line.
      const from = match.index ?? 0
      const end = SOURCE.indexOf('/>', from)
      expect(end).toBeGreaterThan(from)
      const element = SOURCE.slice(from, end)
      expect(element, `<${component}> at index ${from} is missing onContextMenu`).toContain(
        'onContextMenu',
      )
    }
  })

  it('search-result rows are right-clickable', () => {
    // Search results are hand-rolled markup rather than a FileRow, which is
    // precisely why they were missed.
    const searchBlock = SOURCE.slice(
      SOURCE.indexOf('searchResults.map('),
      SOURCE.indexOf('searchResults.map(') + 1600,
    )
    expect(searchBlock).toContain('onContextMenu')
  })

  it('grid-view files expose the same actions as list view', () => {
    // Both call sites build their menu from the SAME fileMenuItems() function,
    // so the two views cannot drift apart in what they offer.
    const gridCall = SOURCE.slice(SOURCE.indexOf('<FileCard'))
    expect(gridCall.slice(0, 500)).toContain('fileMenuItems(file)')
  })

  it('folder context menus include every action the folder card offers', () => {
    const builder = SOURCE.slice(
      SOURCE.indexOf('const folderMenuItems'),
      SOURCE.indexOf('const folderMenuItems') + 800,
    )
    for (const action of ['Open', 'Rename', 'Customize', 'Delete']) {
      expect(builder, `folderMenuItems is missing ${action}`).toContain(`'${action}'`)
    }
  })
})
