// "My Files" in the sidebar (found live 2026-10-19): inside a subfolder,
// clicking it reloaded the subfolder; only the breadcrumb led back. It now
// goes to the top of My Files, as the legacy sidebar did (it marked the root
// active for that view).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SIDEBAR = readFileSync(join(__dirname, 'Sidebar.tsx'), 'utf8')

describe('sidebar My Files', () => {
  it('navigates to the root folder rather than re-showing the current one', () => {
    const views = SIDEBAR.slice(SIDEBAR.indexOf('<nav className="sidebar-views">'), SIDEBAR.indexOf('</nav>'))
    expect(views).toMatch(/v\.id === 'my-files' \? navigateToRoot\(\) : setView\(v\.id\)/)
  })
})
