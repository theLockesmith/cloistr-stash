NIP-XX
======

Hierarchical Encrypted Drive
----------------------------

`draft` `optional`

Defines a client-side-encrypted file drive that uses [Blossom](https://github.com/hzrd149/blossom) blob servers for storage and Nostr relays for an encrypted metadata index. Its distinguishing feature is a **hierarchical key tree** (root → folder → file) in which folder and file keys are *derived*, not stored. This makes sharing a subtree an O(1) operation — hand over one folder key and the recipient derives every descendant key — at the cost of making single-file revocation the expensive case.

This document describes the scheme deployed in production by [Cloistr Stash](https://stash.cloistr.xyz). It is written as a complement to, and contrast with, the per-file-key drive proposal in [nostr-protocol/nips#2412](https://github.com/nostr-protocol/nips/pull/2412): where that proposal stores a random per-file key inside each file's metadata, this one derives every key from a single root, which is what lets a folder be shared without re-wrapping N keys.

---

## Motivation

A drive protocol has to answer four questions: how are blobs encrypted, where do file keys come from, how is a subtree shared, and how is access revoked. The two obvious key models trade off against each other:

| | Per-file stored keys ([#2412](https://github.com/nostr-protocol/nips/pull/2412)) | Derived key tree (this NIP) |
|---|---|---|
| Share one file | Hand over 1 key | Hand over 1 key |
| Share a folder of N files | Hand over N keys (or the drive key = everything) | Hand over **1** folder key; recipient derives the N |
| Revoke one file | Swap its key in metadata (cheap) | **Re-mint file id + re-encrypt blob** (expensive) |
| Rotate a folder / the whole drive | Re-wrap N keys | Re-wrap the key **tree**; blobs untouched (cheap) |

This NIP optimizes for **sharing folders** and **rotating subtrees**, accepting that per-file revocation is the costly path. Implementers whose product centers on single-file revocation should prefer the per-file-key model.

---

## Key Hierarchy

All keys are 256-bit. Derivation is **HKDF-SHA256** with the following exact parameters:

```
salt = 0x00 * 32            (32 zero bytes; input key material is already random)
info = utf8(CONTEXT ":" LABEL)
L    = 32 bytes
```

Context strings are versioned and MUST be treated as opaque constants (changing one is a breaking change to every existing drive):

| Context | Purpose |
|---------|---------|
| `cloistr-drive-root-v1`   | root key (see below) |
| `cloistr-drive-folder-v1` | folder key derivation |
| `cloistr-drive-file-v1`   | file key derivation |
| `cloistr-drive-share-v1`  | share-scoped key derivation |
| `cloistr-drive-search-v1` | encrypted search-index key |
| `cloistr-drive-collab-v1` | collaboration (CRDT) key |

> The `cloistr-drive-*` prefix is a backward-compatibility anchor for existing deployed data; a fresh implementation MAY choose its own prefix but MUST keep it stable forever.

### Root key

The root key is a **random** 256-bit value (NOT derived from the identity key). It is:

1. Stored locally (e.g. IndexedDB), and
2. Wrapped to the owner's own pubkey and published as a replaceable event (see [Root-key event](#root-key-event)) for cross-device recovery.

Randomness (rather than `HKDF(identityKey, …)`) is deliberate: it makes the root **rotatable without changing Nostr identity**. To rotate, generate a new random root, re-derive and re-wrap the folder key tree, and republish. Blobs are never touched.

### Folder key

```
folderKey(id, parent) = HKDF( parent, info = "cloistr-drive-folder-v1:" + id )
```

`parent` is the parent folder's key, or the root key for a top-level folder. Folder keys form a tree mirroring the virtual directory structure.

### File key

```
fileKey(fileId, folderId) = HKDF( folderKey(folderId), info = "cloistr-drive-file-v1:" + fileId )
```

Files at the drive root derive directly from the root key. **File keys are never stored or transmitted** — any holder of the enclosing folder key (or the root) recomputes them on demand. This is the property that makes folder sharing cheap.

---

## Blob Encryption

Two on-the-wire formats. The blob's SHA-256 (as returned by Blossom) is the storage address; the metadata event references it.

### Single blob (files ≤ 10 MiB)

**XChaCha20-Poly1305 (IETF AEAD)**, 24-byte random nonce:

```
blob = nonce (24 bytes) || ciphertext || tag (16 bytes)
```

### Chunked container `CLCH` (files > 10 MiB)

A single self-describing container, so metadata does **not** grow with file size (contrast [#2412](https://github.com/nostr-protocol/nips/pull/2412), which lists every chunk hash in the metadata event):

```
"CLCH" (4)            magic  = 0x43 0x4C 0x43 0x48
version (1)           = 0x01
chunk_size (4, BE)    plaintext bytes per chunk (default 5 MiB)
chunk_count (4, BE)
base_nonce (24)
chunk[0], chunk[1], … each = secretbox(chunk_i) = MAC(16) || ciphertext
```

Each chunk is sealed with `crypto_secretbox` (XSalsa20-Poly1305) under the **same file key** and a **per-chunk nonce derived from the base nonce**:

```
nonce_i = base_nonce, with its last 4 bytes XORed by big-endian uint32(i)
        = base_nonce[0..20] || ( base_nonce[20..24] XOR BE32(i) )
```

Deriving nonces from a base (rather than storing one nonce per chunk) keeps the container header fixed-size. Because `chunk_count` is bounded well under 2³², distinct chunk indices yield distinct nonces under the single random `base_nonce`.

> Note: the single-blob path uses XChaCha20-Poly1305 AEAD while the chunked path uses `crypto_secretbox` (XSalsa20-Poly1305). Both are 24-byte-nonce, 16-byte-tag constructions. An implementation MAY unify on XChaCha20-Poly1305 AEAD for chunks in a future `version = 0x02`; the version byte exists for exactly this.

---

## Event Kinds

| Kind | Addressable | Purpose |
|------|-------------|---------|
| `24242` | no | Blossom upload/delete authorization (per [BUD-01]) |
| `30078` | yes | Encrypted **file** metadata (and the root-key event, `d = "root-key"`) |
| `30079` | yes | Encrypted **folder** metadata |
| `30080` | yes | File/folder **share** to a recipient |
| `30081` | yes | **Public share** tracking (key-in-URL links) |

### File metadata event (kind 30078)

- `d` tag: the file id (a stable client-generated identifier, independent of ciphertext — so re-encryption during rotation/revocation does not change identity).
- `content`: the file's plaintext metadata JSON, encrypted **to the file key** with XChaCha20-Poly1305 (i.e. drive-key-encrypted, not signer-encrypted — no NIP-46 round-trip per file).
- Plaintext fields: `name`, `size`, `type`, `folderId`, `blobHash` (SHA-256 of the encrypted blob), `createdAt`, `previewHash?`, `version?`.

### Folder metadata event (kind 30079)

- `d` tag: the folder id.
- `content`: `{ name, parentId }` encrypted to the folder key.
- Folders are **explicit events** (not virtual path strings). This is what gives each folder a key to share; it is the deliberate cost relative to [#2412](https://github.com/nostr-protocol/nips/pull/2412)'s virtual `folder` string.

### Share event (kind 30080)

Grants a recipient access to a file or folder by wrapping the relevant key **to the recipient's pubkey**:

- `p` tag: recipient pubkey.
- `content`: NIP-44-encrypted `{ type: "file"|"folder", id, key }` where `key` is the file key or folder key. A folder share therefore conveys access to the entire subtree, since the recipient derives descendants with the folder-key context.

### Public share event (kind 30081)

Tracks a key-in-URL public link (the key travels in the URL fragment, never to a relay or server). Used for listing/revoking public links the owner has minted.

### Root-key event (kind 30078, `d = "root-key"`)

- `d` tag: `"root-key"`.
- The wrapped root key is carried in a `["key", <ciphertext>]` tag; `content` is empty.
- The wrap SHOULD be **NIP-44** (`nip44Encrypt(ownPubkey, hex(rootKey))`). Legacy deployments used NIP-04; readers SHOULD accept both (detect NIP-04 by the `?iv=` marker in its ciphertext). See the companion migration note.

---

## Directives

- File/folder metadata `content` MUST be encrypted to the derived file/folder key, NOT to the identity key — this keeps metadata readable offline and avoids a signer round-trip per file.
- Clients MUST skip events they cannot decrypt (not an error — it's how unshared entries are ignored).
- When multiple events share a `d` tag, clients MUST use the highest `created_at`.
- To move/rename: republish the metadata event (same `d`) with updated `folderId`/`name`. Moving a file across folders does **not** re-encrypt its blob, but its file key changes (new folder context); clients MUST re-wrap the file key under the new folder — i.e. republish with the blob re-addressed, OR keep the file key with the file (see Revocation trade-off).
- **Revocation of a single file** requires: mint a new file id, download → decrypt → re-encrypt under the new key → re-upload to Blossom → republish metadata → delete the old blob. Implementations MUST surface this cost to users.
- **Rotation of a folder or the root** re-wraps the key tree only; blobs are left in place.
- Blob deletion MUST use a kind `24242` delete authorization against the Blossom server.

---

## Security Considerations

- **Root key at rest.** The root key is the single most sensitive artifact; its wrapping event SHOULD use NIP-44, not NIP-04. NIP-04 leaks plaintext length and lacks a versioned construction.
- **Metadata leakage.** Blob sizes and event timing are visible to relays and Blossom servers. Folder structure is not (folder names live in encrypted content), but the *shape* of the tree (counts, fan-out) can be inferred from event volume.
- **Nonce uniqueness.** Single-blob nonces are random 24-byte; collision probability is negligible. Chunk nonces are unique by construction per file (base nonce XOR index) — but the base nonce MUST be freshly random per file, never reused across files under the same key.
- **Sharing is transitive by derivation.** A recipient of a folder key can derive all descendant file keys forever, including files added later. Revoking a folder share therefore requires rotating the folder key (and re-wrapping/re-sharing to remaining recipients) — the subtree-rotation path, which is cheap on blobs but requires re-issuing shares.

---

## Relationship to NIP-Metadata / #2412

[#2412](https://github.com/nostr-protocol/nips/pull/2412) and this NIP can coexist. The essential differences:

1. **Key origin.** #2412 stores a random per-file secret key in each file's metadata and encrypts *all* metadata under one drive-wide conversation key. This NIP derives file keys from folder keys from a root, and encrypts each file's metadata under its own file key.
2. **Folders.** #2412 folders are virtual path strings with no key; this NIP's folders are events with keys, enabling subtree sharing.
3. **Chunking.** #2412 lists each chunk's hash (and optional server) in metadata; this NIP uses one fixed-header `CLCH` container with derived per-chunk nonces.
4. **Cipher.** #2412 uses AES-GCM (IV via NIP-44 HKDF); this NIP uses XChaCha20-Poly1305 / secretbox.

A client could import a #2412 drive into this scheme (read per-file keys, re-file under a derived tree) but not the reverse without materializing every derived key. #2412's per-chunk `server` field — spreading one file's chunks across multiple Blossom servers — is a genuinely useful capability this NIP lacks and could adopt independently of its key model.

[BUD-01]: https://github.com/hzrd149/blossom/blob/master/buds/01.md
