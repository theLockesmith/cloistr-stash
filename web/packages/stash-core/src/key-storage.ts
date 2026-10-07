export interface KeyRecord {
  id: string
  pubkey: string
  keyId: string
  type: string
  associatedId: string | null
  encryptedKey: string
  createdAt: number
  updatedAt: number
  /** Pubkey that shared this key with us; absent for keys we own. */
  sharedBy?: string
}

export interface KeyStorage {
  /**
   * When true, Keys refuses to replace a stored key with DIFFERENT key
   * material unless the caller passes `{ replace: true }`. Opt-in per backend.
   */
  readonly refuseOverwrite?: boolean
  init(): Promise<void>
  put(record: KeyRecord): Promise<void>
  get(id: string): Promise<KeyRecord | null>
  delete(id: string): Promise<void>
}

export class IndexedDBKeyStorage implements KeyStorage {
  private db: IDBDatabase | null = null

  constructor(
    private dbName: string,
    private dbVersion: number,
    private storeName: string,
  ) {}

  async init(): Promise<void> {
    if (this.db) return
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' })
          store.createIndex('pubkey', 'pubkey', { unique: false })
          store.createIndex('type', 'type', { unique: false })
        }
      }
    })
  }

  async put(record: KeyRecord): Promise<void> {
    if (!this.db) await this.init()
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const request = store.put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async get(id: string): Promise<KeyRecord | null> {
    if (!this.db) await this.init()
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const request = store.get(id)
      request.onsuccess = () => resolve((request.result as KeyRecord) ?? null)
      request.onerror = () => reject(request.error)
    })
  }

  async delete(id: string): Promise<void> {
    if (!this.db) await this.init()
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const request = store.delete(id)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
}

export class InMemoryKeyStorage implements KeyStorage {
  private store = new Map<string, KeyRecord>()

  async init(): Promise<void> {}

  async put(record: KeyRecord): Promise<void> {
    this.store.set(record.id, { ...record })
  }

  async get(id: string): Promise<KeyRecord | null> {
    const r = this.store.get(id)
    return r ? { ...r } : null
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }
}
