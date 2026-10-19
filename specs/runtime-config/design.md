Stash's image is a Go server (no nginx), so the recipe's nginx template becomes
a Go handler: GET /config.js writes window.__CLOISTR_CONFIG__=<json>; from
CLOISTR_* env vars read at start, production defaults, no-store. JSON via
encoding/json (escapes < > &), so values cannot break out of the script.
Registered as "GET /config.js", which outranks the "/" static fallback.
Frontend: serviceConfig.ts wraps getServiceConfig; blob host keeps Stash's
default (blossom.cloistr.xyz), since the shared default is nostr.download.
The PWA service worker does not precache /config.js (not in dist), so it is
always fetched from the network.
