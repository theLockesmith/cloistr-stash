import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { KeyRecord, KeyStorage } from './key-storage'

function safeFilename(id: string): string {
  return createHash('sha256').update(id).digest('hex') + '.json'
}

export class FileKeyStorage implements KeyStorage {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  async put(record: KeyRecord): Promise<void> {
    const path = join(this.dir, safeFilename(record.id))
    await writeFile(path, JSON.stringify(record), { mode: 0o600 })
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
