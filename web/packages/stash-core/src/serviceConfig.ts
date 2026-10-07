// The only place Stash's frontend names a service address.
//
// Values come from the shared reader (@cloistr/collab-common/config), which
// resolves, highest first: /config.js written by the server at start
// (window.__CLOISTR_CONFIG__, see internal/server/runtimeconfig.go), then the
// build-time VITE_* variable, then the production default. One image can
// therefore run as production or staging; with nothing configured it is
// production, exactly as before.
//
// Read once at import: index.html loads /config.js synchronously before the
// bundle, so the global is already set when this module evaluates.

import { getRuntimeConfig, getServiceConfig } from '@cloistr/collab-common/config'

const runtime = getRuntimeConfig()
// Vite fills import.meta.env at build time; plain Node (headless clients)
// has none, so read it optionally.
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env
const config = getServiceConfig()

export const RELAY_URL: string = config.relayUrl
export const SIGNER_URL: string = config.signerUrl
export const DISCOVERY_URL: string = config.discoveryUrl

/**
 * Host that serves blobs by hash (public, unencrypted copies). Stash's own
 * default is blossom.cloistr.xyz; the shared reader's generic default
 * (a third-party Blossom server) is not used. That is why this one reads
 * the runtime value directly instead of config.blossomUrl: same priority
 * order (runtime, then VITE_BLOSSOM_URL, then default), different default.
 */
export const BLOB_HOST: string =
  runtime.blossomUrl || viteEnv?.VITE_BLOSSOM_URL || 'https://blossom.cloistr.xyz'

export const ENVIRONMENT: string = config.environment
