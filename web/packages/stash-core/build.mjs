// Node build of @cloistr/stash-core -> dist/ (ESM, one file per public module).
//
// The web app never uses this output: it resolves the package through the
// "cloistr-source" export condition straight to src/*.ts. dist/ exists for headless
// consumers (CLI, plain Node), which need runnable JS with real file
// extensions -- tsc cannot emit those from this package's extensionless imports.
//
// bundle + splitting keeps the singletons (Keys, Crypto, Relay, ...) as ONE
// instance shared across entry points, so `import { Keys } from '.../keys'`
// and the index see the same object. Dependencies stay external.
import { readdirSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const entryPoints = readdirSync('src')
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
  .map((f) => `src/${f}`)

rmSync('dist', { recursive: true, force: true })
await build({
  entryPoints,
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
})
