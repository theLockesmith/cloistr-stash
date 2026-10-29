import { describe, expect, it } from 'vitest'
import { metadataNotice, e2eBadgeTitle } from './metadataNotice'

describe('metadataNotice', () => {
  it('tells an old-shape file its name, size and type are readable', () => {
    const n = metadataNotice({ sealed: false })
    expect(n.heading).toBe('Not encrypted yet')
    expect(n.body).toMatch(/name, size and type/)
    expect(n.body).toMatch(/readable/)
  })

  it('treats a file with no sealed flag as old shape', () => {
    expect(metadataNotice({}).heading).toBe('Not encrypted yet')
  })

  it('never tells a sealed file its name is readable', () => {
    const n = metadataNotice({ sealed: true })
    expect(n.heading).not.toBe('Not encrypted yet')
    expect(n.body).not.toMatch(/name, size and type, its folder's name/)
    expect(n.body).toMatch(/name/)
    expect(n.body).toMatch(/encrypted/)
  })

  it('still names what a sealed file does not hide', () => {
    const n = metadataNotice({ sealed: true })
    expect(n.body).toMatch(/size of the encrypted file/)
    expect(n.body).toMatch(/when/)
    expect(n.body).toMatch(/which items share a folder/)
    expect(n.body).toMatch(/how many items and folders/)
  })
})

describe('e2eBadgeTitle', () => {
  it('says the name is not encrypted only for old-shape files', () => {
    expect(e2eBadgeTitle({ sealed: false })).toMatch(/not encrypted yet/)
    expect(e2eBadgeTitle({ sealed: true })).not.toMatch(/not encrypted yet/)
    expect(e2eBadgeTitle({ sealed: true })).toMatch(/name/)
  })
})
