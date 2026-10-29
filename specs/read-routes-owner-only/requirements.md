# Read routes: owner only, NIP-98 hardened

Stacked on !189 (files). cloistr-pr found more unauthenticated pubkey-scoped
reads (2026-10-15).

- R1 GET /api/folders, /api/folders/{id}, /api/shares, /api/keyring: caller's
  auth required (NIP-98 or signer session); anonymous 401, another ?pubkey= 403.
- R2 Shares: only the caller's created shares and shares addressed to them.
- R3 NIP-98 'u' is compared exactly against configured origins
  (DRIVE_AUTH_ORIGINS) + escaped path + raw query, never Host/X-Forwarded-*.
- R4 A NIP-98 event id is accepted once (replay cache, 2x the 60s window).
- R5 The upload handler no longer logs the multipart filename (the real name).
- R6 Web client signs these reads (API.ownGet).
