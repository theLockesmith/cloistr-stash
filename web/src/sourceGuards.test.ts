// Source guards that span the app and @cloistr/stash-core. They read source
// files rather than run code, so they live with the app, which can see both.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appSrc = dirname(fileURLToPath(import.meta.url))
const web = join(appSrc, '..')
const coreSrc = join(web, 'packages/stash-core/src')

function walk(dir: string, visit: (path: string, name: string) => void) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, visit)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) visit(p, name)
  }
}

describe('who may derive a file key directly', () => {
  // keys (the derivation itself), migration (wraps legacy keys), upload and
  // sharing (writes outside wrapped-key mode), versioning (pre-fix fallback).
  // A new caller must go through fileKeyFor instead.
  it('is limited to the known writers and the version fallback', () => {
    const allowed = new Set(
      ['keys.ts', 'migration-wrapped-keys.ts', 'upload.ts', 'sharing.ts', 'versioning.ts'].map((f) => `packages/stash-core/src/${f}`),
    )
    const found: string[] = []
    for (const root of [appSrc, coreSrc]) {
      walk(root, (p) => {
        if (/derive(Root)?FileKey\(/.test(readFileSync(p, 'utf8'))) found.push(p.slice(web.length + 1))
      })
    }
    // keys.ts derives by definition; finding it proves the scan reached the package.
    expect(found).toContain('packages/stash-core/src/keys.ts')
    expect(found.filter((f) => !allowed.has(f))).toEqual([])
  })
})

describe('UI read paths go through the shared reader', () => {
  // FileInfoModal / PreviewModal / KeyboardShortcuts / App's collab download
  // run inside React effects and handlers; pin that each delegates to
  // readFileBytes and chooses no key itself (the cause of the 2026-10-07 bug).
  const files = ['components/FileInfoModal.tsx', 'components/PreviewModal.tsx', 'components/KeyboardShortcuts.tsx', 'App.tsx']
  for (const f of files) {
    it(`${f} reads through readFileBytes`, () => {
      const src = readFileSync(join(appSrc, f), 'utf8')
      expect(src).toMatch(/readFileBytes\(/)
      expect(src).not.toMatch(/deriveFileKey|deriveRootFileKey|decryptFile\(/)
    })
  }
})

describe('own folder keys come from the relay copy', () => {
  // 2026-10-09: a share could overwrite an own folder key, and code that used
  // the local key then wrapped new files under the attacker's key. Own-folder
  // users must go through Keys.resolveOwnFolderKey / restoreOwnFolderKeys.
  it('the app repairs folder keys on load through stash-core, not its own copy', () => {
    const src = readFileSync(join(appSrc, 'state/StashProvider.tsx'), 'utf8')
    expect(src).toMatch(/Keys\.restoreOwnFolderKeys\(/)
    expect(src).not.toMatch(/importSharedFolderKey\(/)
  })

  it('upload wrapping and the wrapped-key migration use resolveOwnFolderKey', () => {
    for (const f of ['upload.ts', 'migration-wrapped-keys.ts']) {
      const src = readFileSync(join(coreSrc, f), 'utf8')
      expect(src, f).toMatch(/resolveOwnFolderKey\(/)
      expect(src, f).not.toMatch(/Keys\.getFolderKey\(/)
    }
  })

  it('folder sharing uses the relay copy for own folders', () => {
    expect(readFileSync(join(coreSrc, 'sharing.ts'), 'utf8')).toMatch(/folder\.encrypted_key\s*\?\s*await Keys\.resolveOwnFolderKey\(/)
  })

  // Residual (d): a folder whose key cannot be verified is refused for new
  // files in stash-core; the app must say so rather than fail silently.
  it('every key check on load refreshes the unverified set, and the file browser shows it', () => {
    const provider = readFileSync(join(appSrc, 'state/StashProvider.tsx'), 'utf8')
    const checks = provider.match(/await restoreFolderKeys\([^)]*\)\n\s*setUnverifiedFolders\(snapshotUnverified\(\)\)/g) ?? []
    expect(checks.length).toBe((provider.match(/await restoreFolderKeys\(/g) ?? []).length)
    expect(checks.length).toBeGreaterThan(0)
    const browser = readFileSync(join(appSrc, 'components/FileBrowser.tsx'), 'utf8')
    expect(browser).toMatch(/unverifiedFolders\.has\(currentFolderId\)/)
  })

  it('both upload entry points refuse an unverified folder before encrypting', () => {
    const src = readFileSync(join(coreSrc, 'upload.ts'), 'utf8')
    expect((src.match(/if \(folderId\) Keys\.assertFolderKeyUsable\(folderId\)/g) ?? []).length).toBe(2)
  })
})

describe('service addresses', () => {
  // Every production service address must come through serviceConfig, or a
  // staging deployment of this image would quietly talk to production.
  it('names no cloistr.xyz service URL outside serviceConfig', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const root of [appSrc, coreSrc]) {
      walk(root, (p, name) => {
        scanned++
        if (name === 'serviceConfig.ts') return
        const hits = readFileSync(p, 'utf8').match(/(?:wss?|https?):\/\/[a-z0-9.-]*cloistr\.xyz/g)
        if (hits) offenders.push(`${p}: ${[...new Set(hits)].join(', ')}`)
      })
    }
    expect(scanned).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})

describe('a malformed configured value', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not stop the login dialog module from loading', async () => {
    vi.resetModules()
    // scheme forgotten
    vi.stubGlobal('window', {
      __CLOISTR_CONFIG__: { signerUrl: 'signer.staging.cloistr.xyz' },
      location: { origin: 'http://localhost:8081' },
    })
    await expect(import('./components/NIP46Dialog')).resolves.toBeDefined()
  })
})
