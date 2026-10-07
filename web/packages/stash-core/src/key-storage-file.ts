import { chmod, lstat, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { KeyRecord, KeyStorage } from './key-storage'

function safeFilename(id: string): string {
  return createHash('sha256').update(id).digest('hex') + '.json'
}

/**
 * Headless key store: one JSON record per key in `dir`.
 *
 * Directory 0700 and record files 0600, tightened on every init/put so a
 * directory or file left looser by something else is corrected rather than
 * trusted. Writes go to a 0600 temp file and are renamed into place, so a
 * crash mid-write never leaves a truncated key record.
 *
 * `refuseOverwrite` makes Keys refuse to replace a stored key with different
 * key material (see Keys.storeEncryptedKey); records here hold self-encrypted
 * ciphertext, so that comparison can only happen above this layer.
 */
export class FileKeyStorage implements KeyStorage {
  readonly refuseOverwrite = true

  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    // lstat, not stat: a symlinked key dir would let the link's owner choose
    // where records go, and chmod would follow it onto the target.
    // A swap between this lstat and the chmod is still possible for someone
    // who can write the parent directory; node:fs offers no fchmod-by-path
    // without following links, so the parent must be trusted.
    const st = await lstat(this.dir)
    if (st.isSymbolicLink()) throw new Error(`Key directory ${this.dir} is a symlink; refusing to use it`)
    if (!st.isDirectory()) throw new Error(`Key directory ${this.dir} is not a directory`)
    await chmod(this.dir, 0o700)
  }

  async put(record: KeyRecord): Promise<void> {
    const path = join(this.dir, safeFilename(record.id))
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
      await chmod(tmp, 0o600)
      await rename(tmp, path)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
  }

  async get(id: string): Promise<KeyRecord | null> {
    const path = join(this.dir, safeFilename(id))
    try {
      const content = await readFile(path, 'utf-8')
      return JSON.parse(content) as KeyRecord
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async delete(id: string): Promise<void> {
    const path = join(this.dir, safeFilename(id))
    try {
      await unlink(path)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
