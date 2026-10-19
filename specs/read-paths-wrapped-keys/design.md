New `web/src/lib/fileKey.ts`: `fileKeyFor(file)` resolves fileId/folderId from
the entry's legacy field aliases and calls `Keys.getFileKey(folderId, fileId,
owner_key ? { ownerEnvelope, signer: getSigner() } : undefined)`. Read paths
(FileInfoModal, PreviewModal, KeyboardShortcuts, App collab download, publish
getPlaintextBytes, versioning create/download) call it. Source-scan test pins
the allowed direct HKDF users: keys, upload (non-wrapped write path), sharing
(non-wrapped re-key), migration, collaboration (R3), versioning (R2 fallback).
