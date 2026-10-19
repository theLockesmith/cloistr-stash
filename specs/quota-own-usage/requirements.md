# GET /api/quota returns only the caller's own usage (orchestrator, 2026-10-07)

Before: anyone could read any key's usage with ?pubkey=<hex> (read-only leak,
real once quota is enabled).
- R1 Unauthenticated: only {"enabled": <bool>}; no per-user numbers. Lets the
  app skip signing entirely while quota is disabled (as in production now).
- R2 Quota enabled + unauthenticated -> 401.
- R3 Authenticated (NIP-98 27235 for this URL+method, or signer session):
  the caller's own usage; ?pubkey= naming anyone else -> 403.
- R4 Web app: unsigned probe first; only when enabled, a signed NIP-98 GET.
