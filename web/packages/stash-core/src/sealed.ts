// Sealed metadata events (drive interop Phase 1, S1 to S5). Spec:
// arbiter/conscience/specs/cloistr-drive-interop/; plan:
// specs/drive-interop-phase1/plan.md.
//
// Everything about a file or folder lives inside one XChaCha20-Poly1305 seal
// in `content`. In the clear a file event carries only a random `d`, the
// opaque folder query tag `q` and the opaque `owner_key` envelope; a folder
// event only `d` and `q`; a key ring only its opaque `d`.
//
//   file content    sealed under HKDF(file key, "cloistr-stash-meta-v1"), so a
//                   single-file share recipient (who holds the file key) can
//                   read it, and a move re-seals nothing
//   folder content  sealed under HKDF(the folder's OWN key, "cloistr-stash-folder-meta-v1"),
//                   so someone given only that folder can read its name
//   ring content    sealed under HKDF(folder key, "cloistr-stash-ring-v1"):
//                   each file's d, id and key, each child folder's d, id and
//                   key, and tombstones
//
// Folder keys are random and wrapped in the parent's ring (conscience
// 2026-10-16: under HKDF derivation, someone removed from a parent could
// compute every later subfolder's key forever).
//
// Each seal binds kind and d as associated data, so content copied onto
// another event does not open. Plaintext is padded (NIP-44 style buckets) so
// the ciphertext length gives away little of the name or tag lengths.

import { Crypto } from './crypto'
import type { UnsignedEvent } from './relay'

export const SEALED_FILE_KIND = 30078
export const SEALED_FOLDER_KIND = 30079

const SEAL_VERSION = 1
const LABEL_FILE = 'cloistr-stash-meta-v1'
const LABEL_FOLDER = 'cloistr-stash-folder-meta-v1'
const LABEL_RING = 'cloistr-stash-ring-v1'

export interface SealedVersion {
  sha256: string
  version: number
  createdAt: number
}

export interface SealedFileMeta {
  id: string
  name: string
  /** Containing folder; null at the root. */
  folderId: string | null
  /** Blossom address of the encrypted blob. */
  sha256: string
  size?: number
  encryptedSize?: number
  mimeType?: string
  /** SHA-256 of the unencrypted file (dedup); never in the clear. */
  plaintextHash?: string
  userTags?: string[]
  versions?: SealedVersion[]
  deletedAt?: number
}

export interface SealedFolderMeta {
  id: string
  name: string
  description?: string
  parentId: string | null
}

/** A ring entry: the item event's random d, its id, and its key. */
export interface RingEntry {
  d: string
  id: string
  key: Uint8Array
}
export type RingFile = RingEntry
export type RingFolder = RingEntry

export interface RingTombstone {
  d: string
  deletedAt: number
}

export interface Ring {
  files: RingFile[]
  folders: RingFolder[]
  tombstones: RingTombstone[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function now(): number {
  return Math.floor(Date.now() / 1000)
}

async function hmacHex(key: Uint8Array, message: string, hexChars: number): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message) as BufferSource))
  return Crypto.bytesToHex(mac).slice(0, hexChars)
}

async function subkey(key: Uint8Array, label: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HKDF' }, false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: enc.encode(label) as BufferSource },
    k,
    256,
  )
  return new Uint8Array(bits)
}

/** Opaque folder query tag: HMAC-SHA256(folder key, "stash-q" || folder id), 32 hex. */
export function folderQ(folderKey: Uint8Array, folderId: string): Promise<string> {
  return hmacHex(folderKey, 'stash-q' + folderId, 32)
}

/** The folder's key-ring address: HMAC-SHA256(folder key, "stash-ring" || folder id), 32 hex. */
export function ringD(folderKey: Uint8Array, folderId: string): Promise<string> {
  return hmacHex(folderKey, 'stash-ring' + folderId, 32)
}

/** The root container's key (the drive's top level, folder id ''), derived from the root key. */
export function rootContainerKey(rootKey: Uint8Array): Promise<Uint8Array> {
  return subkey(rootKey, 'cloistr-stash-root-container-v1')
}

/** A random d for a file or folder event; links to nothing. */
export function randomD(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Crypto.bytesToHex(b)
}

// NIP-44 v2 padding: 32 bytes minimum, then chunks of 1/8 of the next power of two.
function paddedLength(n: number): number {
  if (n <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(n - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((n - 1) / chunk) + 1)
}

function pad(plain: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + paddedLength(plain.length))
  new DataView(out.buffer).setUint32(0, plain.length)
  out.set(plain, 4)
  return out
}

function unpad(padded: Uint8Array): Uint8Array {
  const n = new DataView(padded.buffer, padded.byteOffset).getUint32(0)
  if (n > padded.length - 4 || padded.length - 4 !== paddedLength(n)) throw new Error('sealed content: bad padding')
  return padded.subarray(4, 4 + n)
}

function aad(kind: number, d: string): Uint8Array {
  return enc.encode(`cloistr-stash-seal-v${SEAL_VERSION}|${kind}|${d}`)
}

async function seal(key: Uint8Array, label: string, kind: number, d: string, value: unknown): Promise<string> {
  await Crypto.init()
  const sodium = Crypto.sodium!
  const k = await subkey(key, label)
  const nonce = Crypto.generateNonce()
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    pad(enc.encode(JSON.stringify(value))),
    aad(kind, d),
    null,
    nonce,
    k,
  )
  Crypto.wipeKey(k)
  const out = new Uint8Array(1 + nonce.length + ct.length)
  out[0] = SEAL_VERSION
  out.set(nonce, 1)
  out.set(ct, 1 + nonce.length)
  return Crypto.bytesToBase64(out)
}

async function open<T>(key: Uint8Array, label: string, ev: UnsignedEvent): Promise<T> {
  await Crypto.init()
  const sodium = Crypto.sodium!
  const d = tagValue(ev, 'd')
  if (!d) throw new Error('sealed event has no d')
  const raw = Crypto.base64ToBytes(ev.content)
  if (raw[0] !== SEAL_VERSION) throw new Error(`sealed content: unknown version ${raw[0]}`)
  const nonce = raw.subarray(1, 1 + Crypto.NONCE_LENGTH)
  const ct = raw.subarray(1 + Crypto.NONCE_LENGTH)
  const k = await subkey(key, label)
  let padded: Uint8Array
  try {
    padded = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad(ev.kind, d), nonce, k)
  } catch {
    throw new Error('sealed content does not open for this key and d')
  } finally {
    Crypto.wipeKey(k)
  }
  return JSON.parse(dec.decode(unpad(padded))) as T
}

function tagValue(ev: UnsignedEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1]
}

/** New-shape events have sealed (non-JSON) content; old ones carry a JSON object. */
export function isSealedEvent(ev: UnsignedEvent): boolean {
  return !ev.content.trimStart().startsWith('{')
}

export async function sealFileEvent(args: {
  d: string
  q: string
  fileKey: Uint8Array
  meta: SealedFileMeta
  ownerEnvelope?: string
}): Promise<UnsignedEvent> {
  const tags = [
    ['d', args.d],
    ['q', args.q],
  ]
  if (args.ownerEnvelope) tags.push(['owner_key', args.ownerEnvelope])
  return {
    kind: SEALED_FILE_KIND,
    created_at: now(),
    tags,
    content: await seal(args.fileKey, LABEL_FILE, SEALED_FILE_KIND, args.d, args.meta),
  }
}

export function openFileEvent(ev: UnsignedEvent, fileKey: Uint8Array): Promise<SealedFileMeta> {
  return open<SealedFileMeta>(fileKey, LABEL_FILE, ev)
}

export async function sealFolderEvent(args: {
  d: string
  q: string
  folderKey: Uint8Array
  meta: SealedFolderMeta
}): Promise<UnsignedEvent> {
  return {
    kind: SEALED_FOLDER_KIND,
    created_at: now(),
    tags: [
      ['d', args.d],
      ['q', args.q],
    ],
    content: await seal(args.folderKey, LABEL_FOLDER, SEALED_FOLDER_KIND, args.d, args.meta),
  }
}

export function openFolderEvent(ev: UnsignedEvent, folderKey: Uint8Array): Promise<SealedFolderMeta> {
  return open<SealedFolderMeta>(folderKey, LABEL_FOLDER, ev)
}

// Ring entries are compact (hex d, id and key) to keep a folder's ring well
// under the relay's 512 KB event limit: about 5,900 entries per folder.
type WireEntry = [string, string, string]
type WireRing = { f: WireEntry[]; c: WireEntry[]; t: [string, number][] }

const toWire = (e: RingEntry): WireEntry => [e.d, e.id, Crypto.bytesToHex(e.key)]
const fromWire = ([d, id, key]: WireEntry): RingEntry => ({ d, id, key: Crypto.hexToBytes(key) })

export async function sealRing(args: {
  folderKey: Uint8Array
  folderId: string
  files: RingFile[]
  folders: RingFolder[]
  tombstones: RingTombstone[]
}): Promise<UnsignedEvent> {
  const d = await ringD(args.folderKey, args.folderId)
  const wire: WireRing = {
    f: args.files.map(toWire),
    c: args.folders.map(toWire),
    t: args.tombstones.map((t) => [t.d, t.deletedAt]),
  }
  return {
    kind: SEALED_FOLDER_KIND,
    created_at: now(),
    tags: [['d', d]],
    content: await seal(args.folderKey, LABEL_RING, SEALED_FOLDER_KIND, d, wire),
  }
}

export async function openRing(ev: UnsignedEvent, folderKey: Uint8Array, folderId: string): Promise<Ring> {
  if (tagValue(ev, 'd') !== (await ringD(folderKey, folderId))) {
    throw new Error('not the key ring for this folder (d differs)')
  }
  const wire = await open<WireRing>(folderKey, LABEL_RING, ev)
  return {
    files: wire.f.map(fromWire),
    folders: wire.c.map(fromWire),
    tombstones: wire.t.map(([d, deletedAt]) => ({ d, deletedAt })),
  }
}
