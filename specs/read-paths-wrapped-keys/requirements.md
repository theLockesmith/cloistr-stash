# Read paths honour the file's wrapped key

Found 2026-10-07 by the production revoke e2e (control run): a file uploaded in
wrapped-key mode (random key, `owner_key` tag) fails "Decryption failed" from
Info->Download, Preview, keyboard download, collab content load, publish, and
version history, because those paths derive the HKDF key and ignore owner_key.

- R1 Every read of a file blob uses `Keys.getFileKey` with the file's owner_key
  (unwrap) and falls back to HKDF only when the file has no wrapped key.
- R2 Version history: new versions are encrypted with the file's real key;
  reading a version tries the real key, then HKDF (versions saved before R1).
- R3 Collaboration session key derives from the real file key too. Collab on a
  wrapped file never worked (initial content load already failed), so no prior
  session state exists to preserve. Legacy files: real key == HKDF key, unchanged.
- R4 A guard test fails if a component/lib reads with deriveFileKey directly.
