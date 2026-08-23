/**
 * Mobile sidebar toggle: on-screen guard.
 *
 * Production audit (390×844) found the sidebar collapse toggle (#sidebar-toggle)
 * rendering at left: ~-56px — inside the off-canvas closed sidebar — making it
 * unreachable as the open-sidebar control.  These tests capture the structural
 * requirements that prevent that class of regression:
 *
 *   1. The open-drawer button (#mobile-menu-btn) must not use an inline style to
 *      hide itself; it must rely on a CSS rule so the media-query show is clean.
 *
 *   2. The CSS must explicitly hide .mobile-menu-btn by default (desktop), then
 *      show it inside a mobile breakpoint — no !important needed or present.
 *
 *   3. The CSS must NOT give .mobile-menu-btn any negative horizontal (left/right/
 *      margin-left) value: a negative offset is the exact mechanism that put the
 *      previous toggle off-canvas.
 *
 *   4. The in-sidebar collapse toggle (.sidebar-toggle) must be hidden on mobile
 *      via a max-width media query, because it lives inside the off-canvas sidebar
 *      and calls toggleCollapsed (desktop preference) rather than toggleSidebar.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(__dirname, '../index.css'), 'utf8')
const APP = readFileSync(join(__dirname, '../App.tsx'), 'utf8')

/**
 * Split the CSS into segments: each element is either a @media block (starts
 * with "@media") or a non-media rule (everything else).  Works by scanning for
 * matching braces so nested rules inside @media are captured as one unit.
 */
function splitCssSegments(src: string): { media: boolean; text: string }[] {
  const segments: { media: boolean; text: string }[] = []
  let i = 0
  while (i < src.length) {
    // Skip whitespace / comments at top level
    const mediaMatch = /^@media\b/.exec(src.slice(i))
    if (mediaMatch) {
      const start = i
      // Find the opening brace
      const openBrace = src.indexOf('{', i)
      if (openBrace === -1) break
      // Walk to the matching close brace, counting nesting
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
      // Collect until the next @media or end
      const nextMedia = src.indexOf('@media', i)
      const chunk = nextMedia === -1 ? src.slice(i) : src.slice(i, nextMedia)
      if (chunk.trim()) segments.push({ media: false, text: chunk })
      i = nextMedia === -1 ? src.length : nextMedia
    }
  }
  return segments
}

const segments = splitCssSegments(CSS)

/** Base (non-media) segments that mention a selector. */
function baseSegmentsFor(selector: string): string[] {
  return segments.filter((s) => !s.media && s.text.includes(selector)).map((s) => s.text)
}

/** @media segments (with max-width) that mention a selector. */
function mobileMediaSegmentsFor(selector: string): string[] {
  return segments
    .filter((s) => s.media && /max-width/.test(s.text) && s.text.includes(selector))
    .map((s) => s.text)
}

describe('Mobile sidebar toggle: on-screen requirements', () => {
  it('App.tsx does not hide #mobile-menu-btn with an inline style', () => {
    // The previous pattern `style={{ display: 'none' }}` on the button required
    // `!important` in the CSS to override it — a specificity fight.  Clean CSS
    // wins: display:none in the selector rule, display:flex in the media query,
    // no inline style involved.
    const btnSlice = APP.slice(APP.indexOf('id="mobile-menu-btn"'))
      .slice(0, 300)
    expect(
      btnSlice,
      '#mobile-menu-btn must not carry an inline display:none (use CSS instead)',
    ).not.toContain("display: 'none'")
  })

  it('.mobile-menu-btn has display:none in its base CSS rule (hidden on desktop)', () => {
    const baseText = baseSegmentsFor('.mobile-menu-btn').join('\n')
    expect(
      baseText,
      '.mobile-menu-btn must have display:none in a base (non-media) rule so the element is hidden on desktop without needing an inline style',
    ).toMatch(/\.mobile-menu-btn\s*\{[^}]*display\s*:\s*none/)
  })

  it('.mobile-menu-btn is shown via display:flex inside a max-width media query', () => {
    const mobileText = mobileMediaSegmentsFor('.mobile-menu-btn').join('\n')
    expect(
      mobileText,
      '.mobile-menu-btn must be shown (display:flex) inside a max-width media query',
    ).toMatch(/\.mobile-menu-btn\s*\{[^}]*display\s*:\s*flex/)
  })

  it('.mobile-menu-btn display rule uses no !important', () => {
    // !important was required only while the inline-style fight existed.  With
    // a base display:none and a media-query display:flex, !important is noise.
    const allText = [...baseSegmentsFor('.mobile-menu-btn'), ...mobileMediaSegmentsFor('.mobile-menu-btn')].join('\n')
    // Strip /* ... */ comments before checking so comment text can't falsely match.
    const stripped = allText.replace(/\/\*[\s\S]*?\*\//g, '')
    const displayLines = stripped
      .split('\n')
      .filter((l) => /display\s*:/.test(l))
    const hasImportant = displayLines.some((l) => l.includes('!important'))
    expect(
      hasImportant,
      '.mobile-menu-btn should not need !important on any display rule',
    ).toBe(false)
  })

  it('.mobile-menu-btn CSS has no negative horizontal offset that could push it off-canvas', () => {
    // The audit found the toggle at left: -56px.  Negative left / right /
    // margin-left are the CSS mechanisms that would reproduce that.
    const allText = [...baseSegmentsFor('.mobile-menu-btn'), ...mobileMediaSegmentsFor('.mobile-menu-btn')].join('\n')
    expect(allText, '.mobile-menu-btn must not have a negative left value').not.toMatch(
      /\bleft\s*:\s*-/,
    )
    expect(allText, '.mobile-menu-btn must not have a negative right value').not.toMatch(
      /\bright\s*:\s*-/,
    )
    expect(allText, '.mobile-menu-btn must not have a negative margin-left').not.toMatch(
      /margin(?:-left|-inline-start)\s*:\s*-/,
    )
  })

  it('.sidebar-toggle is hidden on mobile via a max-width media query', () => {
    // .sidebar-toggle lives inside the off-canvas closed sidebar.  At 390px it
    // sits at approximately x = -56px — the exact value measured in the audit.
    // It must be hidden on mobile so #mobile-menu-btn is the sole open-drawer
    // affordance on small screens.
    const mobileText = mobileMediaSegmentsFor('.sidebar-toggle').join('\n')
    expect(
      mobileText,
      '.sidebar-toggle must be hidden (display:none) in a max-width media query — it is inside the off-canvas sidebar on mobile',
    ).toMatch(/\.sidebar-toggle\s*\{[^}]*display\s*:\s*none/)
  })
})
