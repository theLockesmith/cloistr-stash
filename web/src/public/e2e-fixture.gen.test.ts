// Not a unit test: writes real Stash-encrypted blobs for the browser test in
// tests/e2e-public (it runs only when STASH_E2E_FIXTURE_DIR is set). The
// blobs come from stash-core's own Crypto.encryptFile, the code uploads use.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { Crypto } from '@cloistr/stash-core/crypto'

const dir = process.env.STASH_E2E_FIXTURE_DIR

describe.skipIf(!dir)('public-link e2e fixtures', () => {
  it('writes blobs and keys', async () => {
    await Crypto.init()
    mkdirSync(dir!, { recursive: true })
    const sizes = { small: 1000, chunked: Crypto.CHUNKED_THRESHOLD + 777 }
    const out: Record<string, unknown>[] = []
    for (const [label, size] of Object.entries(sizes)) {
      const plain = new Uint8Array(size)
      for (let i = 0; i < size; i++) plain[i] = (i * 31 + label.length) & 0xff
      const key = Crypto.generateKey()
      const blob = new Uint8Array((await Crypto.encryptFile(plain, key)) as Uint8Array)
      const sha256 = createHash('sha256').update(blob).digest('hex')
      writeFileSync(join(dir!, `${sha256}.bin`), blob)
      out.push({
        label,
        sha256,
        key: Crypto.bytesToBase64url(key),
        plainSha256: createHash('sha256').update(plain).digest('hex'),
        size,
      })
    }
    writeFileSync(join(dir!, 'fixtures.json'), JSON.stringify(out))
  }, 60_000)
})
