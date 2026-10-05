import { chmod, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
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
