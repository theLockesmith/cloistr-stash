# CORS for Cloistr origins: requirements

Space (space.cloistr.xyz) calls Stash's files API from the browser. Stash sent
no Access-Control-* headers, so the browser blocked every call (measured
2026-10-15 by the orchestrator: GET and OPTIONS on /api/files with Origin
https://space.cloistr.xyz both 200 with no CORS headers).

- R1 Origins come from config (`server.cors_origins` / `DRIVE_CORS_ORIGINS`,
  comma-separated). Empty means no CORS headers at all. A wildcard is refused
  at startup.
- R2 A preflight from a listed origin answers 204 with Allow-Origin = that
  origin, Allow-Methods GET, POST, DELETE, OPTIONS, Allow-Headers
  Authorization, X-Blossom-Auth, Content-Type.
- R3 Other requests from a listed origin carry Allow-Origin = that origin.
- R4 An unlisted origin gets no Access-Control-* header, preflight or not.
- R5 No Allow-Credentials: cross-origin callers authenticate with a signed
  header, never the session cookie.
- R6 The headers come from the Go service (the ingress is not in ArgoCD's
  tree for drive; the configmap is), set in cloistr-config.
