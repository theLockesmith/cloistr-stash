# Migration: NIP-04 → NIP-44 for the root-key wrap

**Status:** Draft / ready for handoff
**Scope:** `@cloistr/auth` (shared) → `@cloistr/collab-common` (version bump) → `cloistr-stash` (consume)
**Sensitivity:** Production crypto over existing encrypted user data. A regression here can lock users out of their root key (= all files). Back-compat read path is mandatory, not optional.

---

## Why

The root key — the master secret for a user's entire drive — is wrapped to the user's own pubkey and published as a kind `30078` `d="root-key"` event (`key` tag) for cross-device recovery. That wrap currently uses **NIP-04** (`web/src/lib/keys.ts:157` on write, `:103` on read). NIP-04 is deprecated: it leaks plaintext length, has no versioned construction, and reuses a weak scheme. NIP-44 (v2, XChaCha20 + HKDF, versioned, padded) is the correct choice for the most sensitive artifact in the system.

This is surfaced by — but independent of — the comparison against [nips#2412](https://github.com/nostr-protocol/nips/pull/2412), which correctly specifies NIP-44 for its equivalent user-metadata key event.

## Why it isn't a one-file stash edit

The stash data layer encrypts via a signer port (`authBridge.ts` `nip04Encrypt/Decrypt` → collab-common signer `.encrypt()/.decrypt()`). Those signer methods are **hard-wired to NIP-04**:

- `@cloistr/auth` `NIP07Signer.encrypt` → `extension.nip04.encrypt` (`src/nip07.ts:115`)
- `@cloistr/auth` `NIP46Signer.encrypt` → `sendRequest('nip04_encrypt', …)` (`src/nip46.ts:552`)

The shared `SignerInterface` (`@cloistr/auth/src/types.ts:60`) exposes only `encrypt`/`decrypt` (documented as NIP-04). There is **no NIP-44 method on the signer**, and stash cannot self-encrypt NIP-44 locally because it never holds the private key. So NIP-44 must be exposed *on the signer* first.

Good news, already verified:
- The remote signer (coldforge-signer, NIP-46) already implements the `nip44_encrypt` / `nip44_decrypt` RPC methods (`cloistr-signer/internal/api/handler.go:3088`).
- Modern NIP-07 extensions expose `window.nostr.nip44`.
- `collab-common` imports `SignerInterface` from `@cloistr/auth` directly (does **not** re-declare it), so adding methods there flows through with only a dependency bump — no collab-common code change beyond the version.

---

## Change set

### 1. `@cloistr/auth` — expose NIP-44 on the signer (shared, affects all consumers)

**`src/types.ts`** — extend the interface (additive, non-breaking):

```ts
export interface SignerInterface {
  // … existing getPublicKey / signEvent / encrypt / decrypt …

  /** Encrypt using NIP-44 (v2). Preferred over encrypt() for new data. */
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  /** Decrypt a NIP-44 (v2) ciphertext. */
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
}
```

**`src/nip07.ts`** — add the `nip44` capability to the extension shape and implement:

```ts
// extend the extension interface (near the existing nip04? block, ~line 16)
nip44?: {
  encrypt(pubkey: string, plaintext: string): Promise<string>;
  decrypt(pubkey: string, ciphertext: string): Promise<string>;
};

async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
  if (!this.extension.nip44) throw new Error('Extension does not support NIP-44 encryption');
  return this.extension.nip44.encrypt(pubkey, plaintext);
}
async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
  if (!this.extension.nip44) throw new Error('Extension does not support NIP-44 decryption');
  return this.extension.nip44.decrypt(pubkey, ciphertext);
}
```

**`src/nip46.ts`** — add the RPC method names to the `Nip46Method` union (near line 34) and implement:

```ts
// union additions:
| 'nip44_encrypt'
| 'nip44_decrypt'

async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
  return this.sendRequest('nip44_encrypt', [pubkey, plaintext]);
}
async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
  return this.sendRequest('nip44_decrypt', [pubkey, ciphertext]);
}
```

**Fallback for older NIP-07 extensions without `window.nostr.nip44`:** either (a) keep writing NIP-04 when `nip44` is absent (feature-detect at the call site), or (b) polyfill with `nostr-tools/nip44` — but that needs the private key, which a NIP-07 signer does not have. So (a) is the realistic behavior: NIP-44 write is best-effort, NIP-04 remains the compatibility floor. The read path (below) accepts both regardless.

Release as a **minor** version (additive interface). Update `@cloistr/auth` peer/dep in `@cloistr/collab-common` and bump collab-common so consumers resolve the new methods at runtime.

### 2. `cloistr-stash` — thread the methods through the bridge

**`web/src/lib/authBridge.ts`** — extend the structural `Signer` type and the port:

```ts
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<SignedEvent>;
  encrypt(pubkey: string, plaintext: string): Promise<string>;
  decrypt(pubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>; // optional: feature-detect
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
}

// on authPort:
async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
  const s = requireSigner();
  if (!s.nip44Encrypt) throw new Error('signer:no-nip44');
  return s.nip44Encrypt(pubkey, plaintext);
},
async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
  const s = requireSigner();
  if (!s.nip44Decrypt) throw new Error('signer:no-nip44');
  return s.nip44Decrypt(pubkey, ciphertext);
},
```

### 3. `cloistr-stash` — root-key wrap: write NIP-44, read both

Add a format detector and a dual-read helper (NIP-04 v-04 ciphertext always contains the literal `?iv=`; NIP-44 v2 is a single base64 blob whose first decoded byte is `0x02`):

```ts
// web/src/lib/keys.ts
private isNip04(ciphertext: string): boolean {
  return ciphertext.includes('?iv=');
}

/** Decrypt self-wrapped data written by either scheme. */
private async selfDecrypt(pubkey: string, ciphertext: string): Promise<string> {
  if (this.isNip04(ciphertext)) return this.auth.nip04Decrypt(pubkey, ciphertext);
  try {
    return await this.auth.nip44Decrypt(pubkey, ciphertext);
  } catch (e) {
    // last-resort: some extensions produce v04-shaped output without ?iv=
    return this.auth.nip04Decrypt(pubkey, ciphertext);
  }
}

/** Encrypt self-wrapped data, preferring NIP-44, falling back to NIP-04. */
private async selfEncrypt(pubkey: string, plaintext: string): Promise<string> {
  try {
    return await this.auth.nip44Encrypt(pubkey, plaintext);
  } catch {
    return this.auth.nip04Encrypt(pubkey, plaintext); // signer:no-nip44 or extension gap
  }
}
```

Then:

- **`publishRootKeyToNostr` (`keys.ts:157`)**: `nip04Encrypt` → `selfEncrypt`.
- **`restoreRootKeyFromNostr` (`keys.ts:103`)**: `nip04Decrypt` → `selfDecrypt`.

**No migration of existing events is required.** Old `d="root-key"` events stay NIP-04 and are still readable via `selfDecrypt`. The *next* time the root key is (re)published on any device, it is rewritten as NIP-44. A user is never locked out because the read path handles both indefinitely.

Optional opportunistic rewrite: on successful NIP-04 read, if the signer supports NIP-44, re-publish the root-key event under NIP-44 (single write, idempotent by `d` tag + `created_at`). Keep this behind a flag for the first release.

---

## Same pattern applies elsewhere (out of scope here, worth a follow-up)

`selfEncrypt/selfDecrypt` is directly reusable for the other NIP-04 self-wrap sites:
- `keys.ts:262 / :307` — IndexedDB local key store
- `keys.ts:485 / :508` — key-tree backup export/import

And, **higher value than the self-wrap**, the recipient-facing share encryption in `sharing.ts` (`:268 :333 :375 :644 :662 :678 :763`) is NIP-04 encryption *to other users* — that's the case where NIP-04's weaknesses matter most. Migrating shares needs the same signer NIP-44 methods (step 1) plus a versioned share event so recipients know which scheme to use; treat as a separate, larger work item.

---

## Release / rollback

**Order:** ship `@cloistr/auth` (minor) → bump `@cloistr/collab-common` → deploy stash. Steps 2–3 no-op safely on an old auth build (feature-detect throws `signer:no-nip44` → `selfEncrypt` falls back to NIP-04, `selfDecrypt` reads NIP-04). So stash can even ship *before* the auth release and simply keep writing NIP-04 until the signer gains NIP-44 — zero flag-day coupling.

**Rollback:** revert stash to `nip04*` calls. Already-written NIP-44 root-key events would then be unreadable by the reverted build → **before enabling NIP-44 writes in prod, confirm the deployed `@cloistr/auth` on all of the user's devices/paths supports `nip44_decrypt`.** This is the one ordering hazard: don't let NIP-44 *writes* outrun NIP-44 *read* capability in the field.

## Test plan

- Unit: `isNip04` classifier on known NIP-04 and NIP-44 v2 vectors.
- Unit: `selfEncrypt`→`selfDecrypt` round-trip on NIP-07 (with & without `nip44`) and NIP-46 fakes.
- Regression: decrypt a **captured legacy NIP-04 `root-key` event** → recover the exact 32-byte root → derive a known folder/file key (guards the `cloistr-drive-*` HKDF anchors).
- Integration: fresh signup writes NIP-44 root-key; second device restores it; downgrade-to-NIP-04-signer still restores.
- E2E: upload → sign out → sign in on a second session → file decrypts (exercises the full root→folder→file recovery through the new wrap).

## Blast radius

`@cloistr/auth` `SignerInterface` is consumed by ~14 suite apps. The change is **additive** (new optional-in-practice methods; existing `encrypt/decrypt` untouched), so no consumer breaks. But because it's a shared foundation dependency, the release should be coordinated, not cut unilaterally from the stash session.
