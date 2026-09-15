import { describe, it, expect } from 'vitest'
import { manualChunks } from '../vite.config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

describe('manualChunks', () => {
  it('routes react-dom to react-vendor', () => {
    expect(manualChunks('/project/node_modules/react-dom/index.js')).toBe('react-vendor')
  })

  it('routes react to react-vendor', () => {
    expect(manualChunks('/project/node_modules/react/index.js')).toBe('react-vendor')
  })

  it('routes libsodium-wrappers to crypto-kit', () => {
    expect(manualChunks('/project/node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js')).toBe('crypto-kit')
  })

  it('routes libsodium (core) to crypto-kit', () => {
    expect(manualChunks('/project/node_modules/libsodium/dist/modules/libsodium.js')).toBe('crypto-kit')
  })

  it('routes @cloistr/ui to crypto-kit', () => {
    expect(manualChunks('/project/node_modules/@cloistr/ui/dist/index.js')).toBe('crypto-kit')
  })

  it('routes @cloistr/auth to crypto-kit', () => {
    expect(manualChunks('/project/node_modules/@cloistr/auth/dist/index.js')).toBe('crypto-kit')
  })

  it('routes @cloistr/collab-common to crypto-kit', () => {
    expect(manualChunks('/project/node_modules/@cloistr/collab-common/dist/index.js')).toBe('crypto-kit')
  })

  it('routes yjs to collab', () => {
    expect(manualChunks('/project/node_modules/yjs/dist/yjs.mjs')).toBe('collab')
  })

  it('returns undefined for app source files', () => {
    expect(manualChunks('/project/src/App.tsx')).toBeUndefined()
  })

  it('returns undefined for non-chunked node_modules (marked)', () => {
    expect(manualChunks('/project/node_modules/marked/lib/marked.esm.js')).toBeUndefined()
  })
})

describe('App.tsx: dead folder-customize stub removed', () => {
  const appSource = readFileSync(resolve(here, 'App.tsx'), 'utf-8')

  it('does not contain the raw HTML folder-customize-modal stub', () => {
    expect(appSource).not.toContain('id="folder-customize-modal"')
    expect(appSource).not.toContain('id="folder-customize-save"')
    expect(appSource).not.toContain('id="folder-color-picker"')
    expect(appSource).not.toContain('id="folder-icon-picker"')
  })
})
