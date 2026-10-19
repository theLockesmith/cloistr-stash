# Runtime service configuration (one image, prod + staging)

Per cloistr-collab-common docs/runtime-config-adoption.md and
arbiter/cloistr/architecture/staging-environment.md (orchestrator 2026-10-05).

- R1 The frontend reads relay, signer, discovery, blob host through the shared
  reader (@cloistr/collab-common/config getServiceConfig), via one Stash module
  (web/src/lib/serviceConfig.ts). No cloistr.xyz service URL literal elsewhere
  in web/src (guard test).
- R2 Shared-package calls get the configured values (SharedAuthProvider
  signerUrl, Header signerUrl).
- R3 /config.js is served with Cache-Control: no-store and emitted before the
  bundle in index.html (sync script tag).
- R4 Production unchanged: unset env -> production values.
- R5 Done = merged, deployed, live config.js reports production; the same image
  run locally with staging env reports staging hosts and the browser makes no
  request to a production *.cloistr.xyz host.
