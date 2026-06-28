import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// libsodium-wrappers' ESM entry is broken; alias to its CJS build (see vitest.config.ts).
const libsodiumCjs = fileURLToPath(
  new URL('./node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js', import.meta.url),
)

// Stash frontend (React + @cloistr/ui). Go backend serves the built `dist/`
// in production (`server --web web/dist`); in dev we proxy API calls to it.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // REQUIRED with file:-linked @cloistr packages: without deduping, the
    // linked packages pull their own nested React/collab-common, producing a
    // second context instance -> "useNostrAuth must be used within an
    // AuthProvider". See cloistr-signer gotcha (Vite dedupe + npm overrides).
    dedupe: ['react', 'react-dom', '@cloistr/collab-common'],
    alias: { 'libsodium-wrappers': libsodiumCjs },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': 'http://localhost:8080',
      '/public': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
