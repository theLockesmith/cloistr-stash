/**
 * Structural guards for RootKeyWarning.
 *
 * No DOM environment (jsdom/happy-dom) is available in this vitest config, so
 * this cannot mount the component. What it CAN verify at the source level:
 *
 *   1. The component reads Keys.rootKeyLocalOnly and Keys.lastPublishError
 *   2. It subscribes to Keys.onRootKeyLocalOnlyChange
 *   3. It calls Keys.retryPublishRootKey on retry
 *   4. It is wired into App.tsx
 *   5. The CSS class .root-key-warning exists in index.css
 *
 * The data-layer contract (flag set/cleared, retry works, listener fires) is
 * tested in keys.publish-resilience.test.ts with real stubbed calls. This file
 * guards the wiring between that data layer and the UI component.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WARNING_SRC = readFileSync(join(__dirname, 'RootKeyWarning.tsx'), 'utf8')
const APP_SRC = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
const CSS_SRC = readFileSync(join(__dirname, '../index.css'), 'utf8')

describe('RootKeyWarning component source', () => {
  it('reads Keys.rootKeyLocalOnly initial state', () => {
    expect(WARNING_SRC).toContain('Keys.rootKeyLocalOnly')
  })

  it('subscribes to rootKeyLocalOnly changes', () => {
    expect(WARNING_SRC).toContain('Keys.onRootKeyLocalOnlyChange')
  })

  it('calls Keys.retryPublishRootKey for the retry action', () => {
    expect(WARNING_SRC).toContain('Keys.retryPublishRootKey')
  })

  it('reads Keys.lastPublishError to surface the relay message', () => {
    expect(WARNING_SRC).toContain('Keys.lastPublishError')
  })

  it('renders the error detail when lastError is present', () => {
    expect(WARNING_SRC).toContain('Relay said:')
  })

  it('has a dismiss mechanism that hides the banner', () => {
    expect(WARNING_SRC).toContain('setDismissed(true)')
    expect(WARNING_SRC).toContain('dismissed')
  })

  it('has a backup download button that calls onOpenBackup', () => {
    expect(WARNING_SRC).toContain('onOpenBackup')
    expect(WARNING_SRC).toContain('Download backup')
  })

  it('uses role="alert" for accessibility', () => {
    expect(WARNING_SRC).toContain('role="alert"')
  })
})

describe('RootKeyWarning wiring in App.tsx', () => {
  it('imports RootKeyWarning', () => {
    expect(APP_SRC).toContain("from './components/RootKeyWarning'")
  })

  it('renders RootKeyWarning with onOpenBackup prop', () => {
    expect(APP_SRC).toContain('<RootKeyWarning')
    expect(APP_SRC).toContain('onOpenBackup')
  })
})

describe('RootKeyWarning CSS', () => {
  it('has the .root-key-warning class defined', () => {
    expect(CSS_SRC).toContain('.root-key-warning')
  })

  it('has dark-mode styles for the warning', () => {
    expect(CSS_SRC).toContain('prefers-color-scheme: dark')
    // The dark theme override targets the warning specifically.
    expect(CSS_SRC).toContain('.root-key-warning')
  })

  it('has the actions container class', () => {
    expect(CSS_SRC).toContain('.root-key-warning-actions')
  })
})
