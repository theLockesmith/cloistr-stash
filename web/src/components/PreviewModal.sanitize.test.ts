// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

function renderMarkdown(raw: string): string {
  return DOMPurify.sanitize(
    marked(raw, { gfm: true, breaks: true, async: false }) as string,
  )
}

describe('PreviewModal markdown sanitization', () => {
  it('strips script tags', () => {
    const html = renderMarkdown('# Hello\n\n<script>alert("xss")</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('Hello')
  })

  it('strips onerror handlers', () => {
    const html = renderMarkdown('![x](x.png "hover")\n\n<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it('strips javascript: hrefs', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('preserves safe markdown', () => {
    const html = renderMarkdown('# Title\n\n**bold** and *italic*\n\n- item')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<li>item</li>')
  })

  it('preserves safe links', () => {
    const html = renderMarkdown('[example](https://example.com)')
    expect(html).toContain('href="https://example.com"')
  })

  it('strips event handlers on allowed elements', () => {
    const html = renderMarkdown('<div onmouseover="alert(1)">safe text</div>')
    expect(html).not.toContain('onmouseover')
    expect(html).toContain('safe text')
  })
})
