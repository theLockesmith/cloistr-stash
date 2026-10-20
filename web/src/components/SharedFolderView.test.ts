// Browsing a shared folder (2026-10-20): an accepted folder share could be
// accepted but never opened. The Shared view now offers Open on a folder
// share, lists that folder with the shared key, and a file the key does not
// open says so instead of a bare decrypt error.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const VIEW = readFileSync(join(__dirname, 'SharedFolderView.tsx'), 'utf8')
const BROWSER = readFileSync(join(__dirname, 'FileBrowser.tsx'), 'utf8')

describe('Shared view opens a folder share', () => {
  it('offers Open on a decrypted folder share and renders the folder view for it', () => {
    expect(BROWSER).toMatch(/share\.decrypted && content\.type === 'folder'[\s\S]{0,200}setBrowsingShare\(\{ share, name \}\)/)
    expect(BROWSER).toMatch(/view === 'shared' && browsingShare[\s\S]{0,120}<SharedFolderView/)
  })

  it('lists with the shared key only, never our own drive', () => {
    expect(VIEW).toMatch(/Sharing\.sharedFolderKey\(share\)/)
    expect(VIEW).toMatch(/Sharing\.browseSharedFolder\(share\.owner_pubkey, level\.id, level\.key\)/)
    expect(VIEW).not.toMatch(/fetchDrive|getRootKey|loadOwnDrive/)
  })

  it('downloads with the key the listing found, and shows the shared-key message as is', () => {
    expect(VIEW).toMatch(/snap\?\.fileKeys\.get\(file\.id!\)/)
    expect(VIEW).toMatch(/Sharing\.downloadFromSharedFolder\(file, key\)/)
    expect(VIEW).toMatch(/e\.name === 'SharedKeyCannotOpenError' \? e\.message/)
  })

  it('wipes the shared folder key when the view closes', () => {
    expect(VIEW).toMatch(/return \(\) => \{\s*if \(root\) Crypto\.wipeKey\(root\.key\)/)
  })

  it('saves downloads as octet-stream, both from a file share and from a shared folder', () => {
    expect(VIEW).toMatch(/type: 'application\/octet-stream'/)
    expect(BROWSER).toMatch(/saveAsDownload\(data, name\)/)
    expect(BROWSER).not.toMatch(/URL\.createObjectURL\(new Blob\(\[data/)
  })
})
