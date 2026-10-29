// The one call another Cloistr app (Space) uses to list a user's Stash files
// (drive interop Phase 1, step 3). It follows the owner listing rule: ONE REQ
// by author and kind, the tree built locally, never one REQ per folder level.
// The root-key event (kind 30078, d "root-key") comes back in that same REQ;
// the signer decrypts it once. Old-shape and sealed files are read alike.
//
// Note what holding this call means: the root key opens the whole drive, in
// the caller's memory. The decided route for Space is the Stash embed, which
// keeps keys in Stash's origin (plan.md, "(iii)"); this call is for code
// running with the user's own signer.

import { unwrapKeyFromSender, type Envelope, type SignerInterface } from '@cloistr/auth/core'
import type { SignedEvent } from './api'
import { buildOwnDrive, fetchAll, type QueryFn, type UnreadableItem } from './drive'

export interface ListedFile {
  name: string
  mimeType?: string
  size?: number
  /** Blossom address of the (encrypted) blob. */
  sha256: string
  createdAt: number
}

/** Some sealed files could not be read; `files` holds the ones that could. */
export class UnreadableFilesError extends Error {
  constructor(
    public readonly files: ListedFile[],
    public readonly unreadable: UnreadableItem[],
  ) {
    super(`${unreadable.length} file${unreadable.length === 1 ? '' : 's'} could not be read (${unreadable[0].reason})`)
    this.name = 'UnreadableFilesError'
  }
}

type Signer = Pick<SignerInterface, 'decrypt'> & Partial<Pick<SignerInterface, 'nip44Decrypt'>>

const ROOT_KEY_D = 'root-key'

function rootKeyEnvelope(events: SignedEvent[], pubkey: string): string | null {
  let best: SignedEvent | null = null
  for (const ev of events) {
    if (ev.kind !== 30078 || ev.pubkey !== pubkey) continue
    if (ev.tags.find((t) => t[0] === 'd')?.[1] !== ROOT_KEY_D) continue
    if (!best || ev.created_at > best.created_at) best = ev
  }
  return best?.tags.find((t) => t[0] === 'key')?.[1] ?? null
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('root key is not 32 bytes of hex')
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16))
}

// Same dual read as Keys.selfDecrypt: NIP-04 ciphertext carries "?iv=".
async function selfDecrypt(signer: Signer, pubkey: string, ciphertext: string): Promise<string> {
  if (ciphertext.includes('?iv=')) return signer.decrypt(pubkey, ciphertext)
  if (!signer.nip44Decrypt) throw new Error('the signer cannot decrypt NIP-44')
  return signer.nip44Decrypt(pubkey, ciphertext)
}

/**
 * Every file in `pubkey`'s drive that is not in the trash. `relay` sends one
 * REQ and resolves with every event up to EOSE. Throws UnreadableFilesError
 * rather than return a list with files silently missing.
 */
export async function listFiles(
  signer: Signer,
  relay: QueryFn | { query: QueryFn },
  pubkey: string,
): Promise<ListedFile[]> {
  const query = typeof relay === 'function' ? relay : relay.query.bind(relay)
  const events = (await fetchAll(query, { kinds: [5, 30078, 30079], authors: [pubkey] })).filter((e) => e.pubkey === pubkey)

  const envelope = rootKeyEnvelope(events, pubkey)
  const rootKey = envelope ? hexToBytes(await selfDecrypt(signer, pubkey, envelope)) : null

  const drive = await buildOwnDrive(events, pubkey, rootKey, {
    unwrapOwner: (env, d) => unwrapKeyFromSender(env as Envelope, d, pubkey, signer as SignerInterface),
  })
  const files: ListedFile[] = drive.files
    .filter((f) => !f.deleted_at)
    .map((f) => ({
      name: f.name,
      mimeType: f.mime_type,
      size: f.size,
      sha256: f.sha256,
      createdAt: f.created_at as number,
    }))
  for (const key of drive.fileKeys.values()) key.fill(0)
  rootKey?.fill(0)
  if (drive.unreadable.length) throw new UnreadableFilesError(files, drive.unreadable)
  return files
}
