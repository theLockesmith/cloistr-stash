# NIP-46 Remote Signer Authentication Flow

This document describes how cloistr-stash handles authentication when using NIP-46 remote signers (like Amber or nsec.app).

## Overview

NIP-46 allows users to sign Nostr events using a remote signer, keeping their private keys secure on a separate device or service. However, this creates complexity when combined with NIP-42 relay authentication.

## The Challenge

```
NIP-46 Client                    Remote Signer                    Relay
     │                                │                              │
     │  1. Generate ephemeral         │                              │
     │     client keypair             │                              │
     │                                │                              │
     │  2. Connect to relay ──────────────────────────────────────────►│
     │                                │                              │
     │  3. NIP-42 AUTH challenge ◄────────────────────────────────────│
     │                                │                              │
     │  4. Sign AUTH with CLIENT key ─────────────────────────────────►│
     │     (relay knows us as clientPubkey)                          │
     │                                │                              │
     │  5. "Sign this event" ─────────►│                              │
     │                                │                              │
     │  6. Signed with USER key ◄─────│                              │
     │                                │                              │
     │  7. Publish event (userPubkey) ────────────────────────────────►│
     │                                │                              │
     │  8. REJECTED: "restricted -    │                              │
     │      you can only publish as   ◄────────────────────────────────│
     │      your authenticated identity"                              │
```

The problem: The relay authenticated us with the ephemeral **client keypair**, but published events are signed with the **user's actual keypair**. The relay sees a mismatch and rejects.

## The Solution: Lazy Re-authentication

Instead of proactively re-authenticating (which causes race conditions), we use lazy re-auth:

1. **Login completes normally** - no extra auth overhead
2. **First publish attempt** - may get "restricted" error
3. **On "restricted" error**:
   - Store the event for retry
   - Ask remote signer to sign a NIP-42 AUTH event with user's pubkey
   - Send AUTH to relay (now relay knows us as userPubkey)
   - Retry the stored publish events
4. **Subsequent publishes** - work normally

```
NIP-46 Client                    Remote Signer                    Relay
     │                                │                              │
     │  Publish event ────────────────────────────────────────────────►│
     │                                │                              │
     │  "restricted" ◄────────────────────────────────────────────────│
     │                                │                              │
     │  "Sign NIP-42 AUTH" ───────────►│                              │
     │                                │                              │
     │  Signed AUTH ◄─────────────────│                              │
     │                                │                              │
     │  AUTH (userPubkey) ────────────────────────────────────────────►│
     │                                │                              │
     │  "OK" ◄────────────────────────────────────────────────────────│
     │                                │                              │
     │  Retry publish ────────────────────────────────────────────────►│
     │                                │                              │
     │  "OK" ◄────────────────────────────────────────────────────────│
```

## Security Model

This approach is secure because:

1. **Cryptographic verification**: The relay verifies every event signature, regardless of connection auth state
2. **Remote signer trust**: Only the remote signer can produce valid signatures
3. **Session security**: NIP-46 sessions require the bunker URL secret
4. **Re-auth just announces**: It tells the relay "events from userPubkey are from this connection" - doesn't grant new capabilities

The relay's identity check is defense-in-depth, not the primary security control.

## Code Locations

- `web/js/nip46.js`:
  - `handleAuthChallenge()` - Responds to NIP-42 AUTH challenges
  - `_reAuthInBackground()` - Signs AUTH with user's pubkey via remote signer
  - `_reAuthAndRetry()` - Triggered on "restricted" error, re-auths and retries
  - `handleRelayMessage()` - Detects "restricted" errors and triggers re-auth

## Error Messages

| Error | Meaning | Handled By |
|-------|---------|------------|
| `auth-required` | Relay requires NIP-42 auth before accepting events | Store for retry, wait for AUTH challenge |
| `restricted: you can only publish as your authenticated identity` | Pubkey mismatch between auth and event | Trigger re-auth with user pubkey, then retry |
| `rate-limited` | Too many events too fast | Reject with user-friendly message |

## Testing

1. Login with NIP-46 remote signer (e.g., Amber)
2. Upload a file
3. Console should show:
   - `NIP-46: Identity mismatch - triggering re-authentication`
   - `NIP-46: Starting re-auth and retry for 1 events`
   - `NIP-46: Sent re-auth for relay: wss://relay.cloistr.xyz`
   - `NIP-46: Retried event after re-auth: [eventId]`
4. File should appear in the list

## History

This flow was implemented in commits:
- `b0fd2a7` - Initial fix for NIP-42 auth identity mismatch
- `2276d81` - Made re-auth non-blocking
- `33525ab` - Switched to lazy re-auth to avoid race conditions
