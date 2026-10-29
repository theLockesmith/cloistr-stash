# Degraded start: recover, and never answer "no files" for "unreachable"

2026-10-15: a pod started during a relay outage kept a nil metadata store for
3+ hours (main set it to nil, nothing retried), returned EMPTY lists for half
of all list requests and panicked on /api/keyring.

- R1 A failed first connect keeps the store; KeepConnected retries in the
  background (1s doubling to 1 min), and checks every 15s while up.
- R2 The store's reconnect context is long-lived (it was the 10s startup
  timeout, so every later reconnect failed).
- R3 GET /ready is 503 until the relay is connected; /health stays liveness.
- R4 Every data route answers 503 for a missing store, an unconnected store or
  an unanswered relay query: never an empty list, never a panic.
- R5 Lists use EOSE-or-error queries (QuerySync returns empty on a timeout).
  GetFolder: not found 404, unanswered 503.
- R6 Blossom is watched in the background (logged, reported by /ready, not
  gated on: reads work without it).
