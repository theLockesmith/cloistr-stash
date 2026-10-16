# List files: owner only

GET /api/files?pubkey=<any> listed that key's file metadata (names, sizes,
MIME, folder, plaintext hash) to anyone. Measured 2026-10-15: the same events
are served by wss://relay.cloistr.xyz to anonymous readers, so this closes the
endpoint, not the leak; the relay-side fix is specs/relay-metadata-encryption.

- R1 Anonymous list: 401. Bad or mismatched auth (other URL/method): 401.
- R2 Authenticated, ?pubkey= naming someone else: 403.
- R3 Authenticated, own ?pubkey= or none: 200, the caller's files.
- R4 GET /api/files/{sha256} requires auth.
- R5 Auth = the existing mechanisms: NIP-98 for this URL, or the signer session.
- R6 The Drive web app keeps working: plain request first (session cookie), on
  401 NIP-98 for the exact URL, then signs directly for the page load.
