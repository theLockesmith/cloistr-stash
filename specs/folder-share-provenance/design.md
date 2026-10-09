# Folder share provenance: design

- KeyRecord.sharedBy (existing optional field) records who shared a key.
  KeyRecord.verifiedTag records the relay 'key' tag a local own key was
  checked against, so each tag is decrypted once, not on every load.
- Keys.importSharedFolderKey(folderId, enc, sender, { isOwnFolder }):
  same bytes -> no-op; no record -> store with sharedBy; record.sharedBy ===
  sender -> replace; record.sharedBy other -> refuse; record without
  sharedBy (owned, or pre-provenance) -> refuse unless isOwnFolder() says
  false; no checker or checker error -> refuse. Sender === self -> treated
  as the own-key restore (resolveOwnFolderKey).
- Keys.resolveOwnFolderKey(folderId, keyTag, parentId): tag present ->
  tag is authoritative (decryptable self-encryption proves it is ours);
  store/repair locally as owned. No tag -> drop a local record that has
  sharedBy, then getFolderKey (derivation).
- Keys.restoreOwnFolderKeys(folders): resolveOwnFolderKey for every listed
  own folder with a tag, on every load (old code skipped folders that already
  had a local key, which is why a poisoned browser never healed).
- Sharing.acceptShare passes isOwnFolder = relay query
  { kinds:[30079], authors:[me], '#d':[folderId] }.
- Residual: an own folder with no 'key' tag whose poisoned record predates
  sharedBy (written before 2026-10-08) cannot be told apart from an own
  key; left as is.
