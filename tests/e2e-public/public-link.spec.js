// @ts-check
// Opens real public share links in a real browser and checks the file comes
// out decrypted, byte for byte, and that the key never leaves the page.
//
// Setup: stash-core encrypts two files (one chunked) into real blobs; a local
// HTTP server plays Blossom and serves them; the real Go server runs with the
// built web app (web/dist) in front of it.
const { test, expect } = require('@playwright/test')
const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const PORT = 9483
const BLOSSOM_PORT = 9484

/** @type {{label:string, sha256:string, key:string, plainSha256:string, size:number}[]} */
let fixtures = []
let tmp = ''
/** @type {http.Server} */
let blossom
/** @type {import('node:child_process').ChildProcess} */
let server

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!fs.existsSync(path.join(ROOT, 'web/dist/index.html'))) throw new Error('run `npm run build` in web/ first')
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-public-e2e-'))
  execFileSync('npx', ['vitest', 'run', 'src/public/e2e-fixture.gen.test.ts'], {
    cwd: path.join(ROOT, 'web'),
    env: { ...process.env, STASH_E2E_FIXTURE_DIR: tmp },
    stdio: 'pipe',
  })
  fixtures = JSON.parse(fs.readFileSync(path.join(tmp, 'fixtures.json'), 'utf8'))

  blossom = http.createServer((req, res) => {
    const id = (req.url || '').split('?')[0].slice(1)
    const file = path.join(tmp, `${id}.bin`)
    if (!/^[0-9a-f]{64}$/.test(id) || !fs.existsSync(file)) {
      res.writeHead(id === '' ? 200 : 404)
      return res.end()
    }
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
  await new Promise((r) => blossom.listen(BLOSSOM_PORT, '127.0.0.1', () => r(undefined)))

  const bin = path.join(tmp, 'stash-server')
  execFileSync('go', ['build', '-o', bin, './cmd/server'], { cwd: ROOT, env: { ...process.env, GOWORK: 'off' } })
  server = spawn(bin, ['--config', path.join(tmp, 'none.yml'), '--web', path.join(ROOT, 'web/dist')], {
    env: {
      ...process.env,
      DRIVE_HOST: '127.0.0.1',
      DRIVE_PORT: String(PORT),
      DRIVE_BLOSSOM_URL: `http://127.0.0.1:${BLOSSOM_PORT}`,
      DRIVE_RELAY_URL: 'ws://127.0.0.1:9',
      USE_CLOISTR_FALLBACK: 'false',
    },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/config.js`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('stash server did not start')
})

test.afterAll(async () => {
  server?.kill()
  await new Promise((r) => (blossom ? blossom.close(() => r(undefined)) : r(undefined)))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

for (const label of ['small', 'chunked']) {
  test(`opens a ${label} file from its share link, and the key never leaves the page`, async ({ page }) => {
    const f = fixtures.find((x) => x.label === label)
    if (!f) throw new Error(`no ${label} fixture`)
    /** @type {string[]} */
    const seen = []
    page.on('request', (req) => {
      seen.push(req.url())
      for (const v of Object.values(req.headers())) seen.push(v)
    })

    await page.goto(`/public/${f.sha256}#${f.key}`)
    await expect(page.getByRole('button', { name: /download/i })).toBeVisible()
    // The key is read, then taken out of the address bar.
    expect(new URL(page.url()).hash).toBe('')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /download/i }).click(),
    ])
    const file = await download.path()
    const bytes = fs.readFileSync(/** @type {string} */ (file))
    expect(bytes.length).toBe(f.size)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.plainSha256)
    await expect(page.getByRole('status')).toHaveText(/complete/i)

    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(s).not.toContain(f.key)
    // Nothing on this page comes from a CDN.
    for (const s of seen.filter((x) => /^https?:/.test(x))) expect(new URL(s).host).toBe(`127.0.0.1:${PORT}`)
  })
}

test('a wrong key says the link is wrong', async ({ page }) => {
  const f = fixtures[0]
  const wrong = Buffer.alloc(32, 7).toString('base64url')
  await page.goto(`/public/${f.sha256}#${wrong}`)
  await page.getByRole('button', { name: /download/i }).click()
  await expect(page.getByRole('status')).toHaveText(/could not be decrypted/i)
})

test('a link without its key says so', async ({ page }) => {
  await page.goto(`/public/${fixtures[0].sha256}`)
  await expect(page.getByRole('alert')).toHaveText(/missing its key/i)
})

test('a link to a missing file is a 404, and a non-hash id is a 400', async ({ request }) => {
  expect((await request.get(`/public/${'0'.repeat(64)}`)).status()).toBe(404)
  expect((await request.get(`/public/${fixtures[0].sha256.toUpperCase()}`)).status()).toBe(400)
})
