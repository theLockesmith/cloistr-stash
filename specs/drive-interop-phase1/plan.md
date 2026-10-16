# Drive interop Phase 1 (Stash metadata): build plan

Spec: arbiter/conscience/specs/cloistr-drive-interop/ (signed 2026-10-16), Phase 1, S1 to S7.
Supersedes the narrower wip on feat/encrypt-relay-metadata (374228c), which kept
`folder`/`parent`/`wk` in clear. Built test-first; nothing merges before !191 and !192.
Readings confirmed and corrected by conscience 2026-10-16 (relayed by cloistr-orchestrator).

## Format

1. **File event (30078).** Content sealed under HKDF(file key, "cloistr-stash-meta-v1").
   Sealed under the FILE key so a single-file share recipient reads the name; a move
   re-seals under the same key and republishes, re-keying nothing.
2. **Folder event (30079).** Content sealed under HKDF(the folder's OWN key,
   "cloistr-stash-folder-meta-v1"), so someone given only that folder reads its name.
3. **Folder keys are random, never HKDF-derived going forward.** Each child folder's key is a
   wrapped entry in the parent's ring (and to the owner). Existing derived folders carry their
   final derived value once (derive once, then wrap, per key-model.md), building on
   migration-wrapped-keys.ts. Reason: under derivation, someone removed from a parent can compute
   every later subfolder's key forever.
4. **`q`.** HMAC-SHA256(container folder key, "stash-q" || container folder id), 32 hex, on every
   file event and child folder event in that container. Root has one too.
5. **Key ring (30079), one per folder.** `d` = HMAC(folder key, "stash-ring" || folder id).
   **Its only tag is that opaque `d`**: no `q`, `wk`, `parent` or name. A holder finds it by `#d`.
   Content sealed under HKDF(folder key, "cloistr-stash-ring-v1"): files (d, id, key), child
   folders (d, id, key), tombstones. Every owner write is read-merge-write.
   Limit: compact entries keep a ring under the relay's 512 KB event cap up to about 5,900
   entries per folder.
6. **Owner fallback.** `owner_key` (opaque envelope to the owner) stays on the file event, so a
   ring entry lost to a two-device race never costs the owner a file.
7. **In the clear:** file event `d` (random), `q`, `owner_key`; folder event `d` (random), `q`;
   ring `d` only. `x` moves inside content unless step 5 finds a server path that truly needs it.
8. **Seal.** XChaCha20-Poly1305 (the blob cipher), kind and d bound as associated data (content
   copied to another event does not open), plaintext padded to NIP-44 v2 buckets.

## Listing (correction 3: never teach the relay the tree)

- **Owner:** ONE REQ by author and kinds 30078/30079, tree built locally from the root ring down.
  Never breadth-first by `#q`, one REQ per level: that hands the relay the parent-to-child edges.
- **Recipient:** `#q` only for the folders shared with them.
- **Drive too large to fetch whole:** all known q values in one REQ, never per level.
- Old-shape events are dual-read until migrated. The Space `listFiles` call follows the same rules.

## Steps, each test-first, each its own MR

1. Codec (stash-core `sealed.ts`): seal/open file, folder and ring events; q and ring d. Outsider
   test: every event, no keys, yields no tree, type, size, tag, name or plaintext hash.
2. Read path: owner single-REQ listing and local tree build, recipient `#q` listing, dual read.
   The web app lists from the relay, no longer through /api/files.
3. **Space support (orchestrator 2026-10-16), right after 1 and 2:**
   (i) publish @cloistr/stash-core to the group registry (confirmed never published: `npm view`
   404 while @cloistr/ui resolves, so not the outage) with one call,
   `listFiles(signer, relay, pubkey) -> [{name, mimeType, size, sha256, createdAt}]`, dual read,
   listing rules above; tell cloistr-space directly when published.
   (ii) a test helper that builds a migrated file event.
   (iii) written answer on how another origin gets the keys (see below). DECIDED 2026-10-16
   (orchestrator): the EMBED.
   (iv) The embed, right after listFiles: Stash serves the Files view from its own origin,
   Space frames it, keys never leave Stash's origin, only picked items go back by postMessage
   to an allow-listed parent (exact origin match, no wildcards). It gates the migration flag in
   place of Space's native listing. When it and its postMessage contract are ready, tell the
   orchestrator, who hands Space their half.
4. Write paths: upload, rename, move (republish with new q; both rings read-merge-write; a stale
   entry loses to the file's own content), delete (kind 5 of the item event + ring tombstone),
   new folder (random key, wrapped in the parent's ring and to the owner), versions, tags, star.
5. Migration (stash-core, shared by web and headless). Ships behind a flag, OFF, until Space's
   Files widget uses the Stash embed (orchestrator ordering rule). Reads all old events, writes the
   new shape, derives existing folder keys once and wraps them, verifies every new file opens
   (metadata opens, key unwraps, blob decrypts), only then one kind 5 naming the old events.
   Any unreadable file: refuse, publish nothing, keep the old shape.
6. Server: neutral multipart filename (no names in logs); /api/files and /api/folders pass
   new-shape events through opaque.
7. UI help text, S7 residue: author, timestamps, event count, Blossom blob hash and its size, and
   that observers can count rings and see how often each is rewritten (per-folder activity timing).
8. Live probe on production relay + Blossom, throwaway keys kept for cleanup: outsider learns no
   tree/type/size/tag; folder recipient lists exactly that folder by `#q`; non-recipient query
   returns nothing useful; control in the same run (an old-shape event IS readable to the same
   outsider, proving the probe can see a leak).

## (iii) How a different origin (Space) gets the keys

The root key is stored on the relay NIP-44-encrypted to the user's own pubkey (30078, d
`root-key`). Any origin holding the user's signer can ask for one `nip44Decrypt` (one signer
prompt, or none if the signer auto-approves that app) and then holds the root key, which opens
every ring, every folder key and every file in the drive. So "Space gets the keys" means Space
gets full read access to the whole drive, in another origin's memory and storage.

Decided 2026-10-16: the embed. Space should not hold the root key. Alternative: Stash serves a small embed from
its own origin (stash.cloistr.xyz/embed/files) that Space frames; the keys stay in Stash's origin,
and the embed renders the list and passes only what the user picks (name, sha256, a share link)
back by postMessage to an allow-listed parent origin. If the operator prefers Space to list
natively, the honest cost is that one decrypt prompt gives Space the whole drive.

## Impact outside Stash (flag, not mine to change)

- Space's Files widget reads /api/files: migrated files show no names until it lists via
  stash-core or the embed. Migration flag stays off until then.
- Copies of old events on other relays are not recalled (residue, stated).
- The relay must index `#q` (single-letter tag, standard); the probe confirms.
