# Folder share provenance: design

- KeyRecord.sharedBy (existing optional field) records who shared a key.
  KeyRecord.verifiedTag records the relay 'key' tag a local own key was
  checked against, so each tag is decrypted once, not on every load.
- Keys.admitFolderKey(folderId, key, from, { rotation, existingCameFromSender }):
  the ONE admission rule for keys from outside (shares and backups). Same
  bytes -> no-op; no record -> store, recording `from` only if it is not us;
  different bytes -> replace only if rotation is allowed and record.sharedBy
  === from, or (pre-provenance record) existingCameFromSender(localHex)
  returns true. Anything else, including an empty/failed proof, refuses.
- Keys.importSharedFolderKey(folderId, enc, sender, { existingCameFromSender }):
  admitFolderKey with rotation. Sender === self -> resolveOwnFolderKey.
  Sharing.senderSharedFolderKey is the proof: the sender's own kind-30080
  share to us for that folder whose key equals the local key.
- Keys.importBackup: folder entries -> admitFolderKey without rotation;
  other keys only fill gaps (never replace different bytes). exportBackup
  carries foreign sharedBy; a backup can never mark a key as ours.
- Keys.resolveOwnFolderKey(folderId, keyTag, parentId): tag present ->
  tag is authoritative (decryptable self-encryption proves it is ours);
  store/repair locally as owned. No tag -> drop a local record that has
  sharedBy, then getFolderKey (derivation).
- Keys.restoreOwnFolderKeys(folders): resolveOwnFolderKey for every listed
  own folder with a tag, on every load (old code skipped folders that already
  had a local key, which is why a poisoned browser never healed).
- Sharing.acceptShare passes isOwnFolder = relay query
  { kinds:[30079], authors:[me], '#d':[folderId] }.
- Untagged own folder, pre-provenance record: compare with the derived key
  (root or parent). Equal -> mark ours. Different -> 'unverified': kept for
  reads, Keys.unverifiedFolders, uploads refused (FolderKeyUnverifiedError),
  FileBrowser shows a notice. Under an unverified parent nothing is vouched.
- Repair cascade: a repair returns the replaced key; restoreOwnFolderKeys
  (parents first) re-derives untagged children whose stored key equals the
  derivation from the replaced key, recursively. Other child keys untouched.
