# Key Derivation vs. Per-Item Keys

Stash uses both hierarchical key derivation (HKDF) and per-item independent
keys. The choice is determined by the sharing unit, not by the storage model.

## Folders derive their children

A folder key is derived from the root key. Every file inside the folder derives
its own key from the folder key. Handing someone the folder key gives them every
file in it — that is the point of a folder.

    root key → HKDF("cloistr-drive-folder-v1", folderId) → folder key
    folder key → HKDF("cloistr-drive-file-v1", fileId) → file key

This means sharing a folder is one operation regardless of how many files it
contains. The recipient derives every child key locally.

## Individually shared files use independent keys

A file shared outside its folder context derives its key directly from the root
key, not from any folder key. This is deliberate: a derived key cannot reach one
recipient without reaching whatever it was derived from. If a file key came from
a folder key, sharing the file would implicitly share every sibling.

    root key → HKDF("cloistr-drive-file-v1", fileId) → file key

The recipient gets this one key and nothing else.

## Why both exist

The unresolved tension in encrypted-drive designs is whether keys should derive
from a parent (making bulk sharing cheap) or be per-item (making selective
sharing possible). The answer is that derivation is a property of the sharing
unit, not of the storage:

- A **folder** derives its children because handing over the folder is the
  operation being performed. Derivation makes this O(1).
- An **individually shared file** must not derive from its folder, because a
  derived key cannot reach one reader without reaching whatever it came from.

Both models coexist in the same HKDF hierarchy. The root key is the single
secret; everything else is derived, but the derivation path determines the
blast radius of any one share.

## Revocation

Revocation is key rotation: generate a new file ID, derive a new key,
re-encrypt, re-upload, delete the old blob. This is all-or-nothing across
every recipient. Anyone who fetched the old key keeps it forever, so per-
recipient revocation is not possible without a full rotation.

After rotation, stale share records on the relay still show that a sharing
relationship existed. The old key no longer decrypts the file (the old blob
is deleted), but the metadata — that two keys exchanged something — survives
on any relay that saw the original share event. Best-effort NIP-09 deletion
requests are sent but are not guaranteed to be honoured.

## Share record privacy

Share events (kind 30080) carry only two plaintext tags: the share ID (`d`)
and the recipient (`p`). The item's coordinate, permission level, and file
metadata are inside the encrypted payload, readable only by the sender and
recipient. A stranger who queries the relay learns that the author shared
something with the recipient and nothing else.

Accepted exposure: the records are authored by the sharer, so the shape of
someone's sharing activity (how many shares, to how many distinct recipients)
is visible. Hiding the author was rejected because its failure mode is a
recipient who is silently never notified of a share.
