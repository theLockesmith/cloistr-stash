import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// libsodium-wrappers' ESM entry is broken; alias to its CJS build (see vitest.config.ts).
const libsodiumCjs = fileURLToPath(
  new URL('./node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js', import.meta.url),
)

// Stash frontend (React + @cloistr/ui). Go backend serves the built `dist/`
// in production (`server --web web/dist`); in dev we proxy API calls to it.
export default defineConfig({
  plugins: [
    react(),
    // PWA: Workbox precache of the hashed Vite assets + installable manifest.
    // Replaces the legacy hand-written sw.js (which cached now-removed /js paths).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // The app bundle is ~1.2MB; allow precaching it (maps excluded above).
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
      },
      manifest: {
        name: 'Cloistr Stash',
        short_name: 'Stash',
        description: 'Nostr-native file storage with end-to-end encryption',
        start_url: '/',
        display: 'standalone',
        background_color: '#1a1a2e',
        theme_color: '#1a1a2e',
        orientation: 'any',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
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
