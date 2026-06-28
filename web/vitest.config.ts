import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// libsodium-wrappers ships a broken ESM entry (its .mjs imports a sibling
// libsodium.mjs that lives in the `libsodium` package, unresolvable under
// node ESM). Alias to the working CJS build so it loads in tests and bundles.
const libsodiumCjs = fileURLToPath(
  new URL('./node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js', import.meta.url),
)

// Node environment is sufficient: libsodium-wrappers runs in node, and
// WebCrypto (crypto.subtle, used by HKDF) is available on globalThis in
// modern Node. No React plugin here on purpose (these are pure-logic tests).
export default defineConfig({
  resolve: {
    alias: { 'libsodium-wrappers': libsodiumCjs },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
