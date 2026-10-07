# Auth event validation (security fix)

Source: cloistr-orchestrator 2026-10-05 (finding from cloistr-pages).
Confirmed on production 2026-10-05: a replay of a throwaway victim's public
kind-1 event as `Authorization: Nostr <b64>` passed auth on POST
/api/metadata, /api/folders, /api/shares (400 from the handler, not 401).

R1. THE server SHALL accept a `Nostr <b64>` auth header only when the event
    signature verifies AND the event is one of:
    - kind 27235 (NIP-98): `u` tag equals the request URL (scheme/host via
      X-Forwarded-Proto/Host when present, path + query), `method` tag equals
      the request method, created_at within +/-60s of now.
    - kind 24242 (Blossom), ONLY on blob routes: POST /api/files requires
      `t`=upload; DELETE /api/files/{sha256} requires `t`=delete and an `x`
      tag equal to {sha256}. `expiration` tag present and in the future;
      created_at not more than 60s in the future.
    Any other kind, a missing/mismatched tag, or a bad signature SHALL be
    refused with 401.
R2. The quota path SHALL use only a signature-verified pubkey (upload/delete
    use the pubkey the middleware authenticated; GET /api/quota verifies the
    header's signature).
R3. A non-`Nostr` Authorization header (e.g. `Bearer`) SHALL fall through to
    the signer-session check instead of being treated as unauthenticated.
R4. The Stash web app's existing requests SHALL keep working: uploads send
    24242 t=upload + x + expiration(+300s) in X-Blossom-Auth; deletes send
    24242 t=delete + x + expiration.
R5. Live proof after deploy: the replay is refused (401) and a correct
    NIP-98 request passes auth, on the same zero-side-effect probe.
