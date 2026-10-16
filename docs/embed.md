# Stash embed: the file picker other Cloistr apps frame

Stash lists a user's drive at `/embed/files`, on Stash's own origin. Another
Cloistr app (Space) frames that page. The root key, folder keys and file keys
stay in Stash's origin; the framing app receives only the files the user
picks, by `postMessage`, and only if it is on Stash's allow-list.

This is how Space shows a migrated (sealed) drive without ever holding the
user's root key. Asking the signer to decrypt the root key in Space's own
origin would give Space read access to the whole drive.

## Who may frame it

One list, set on the Stash server: `CLOISTR_EMBED_PARENTS`, exact origins
separated by spaces or commas. Default: `https://space.cloistr.xyz`. Staging
sets `https://space.staging.cloistr.xyz`. Every entry must be exactly
`https://host[:port]` (or `http://localhost[:port]` for development), lower
case. If any entry is anything else (`*`, `https://*.x`, a trailing `/` or dot,
a path, `;`, a quote, plain `http` off localhost, upper case), the server
refuses to start and logs the bad entry, so a typo or an injected CSP directive
never reaches a response. An empty list means nobody can frame it.

The list is enforced twice:

1. The server sends it as the embed's `Content-Security-Policy: frame-ancestors`,
   so browsers will not render the embed inside any other site. Every other
   Stash page sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
2. The embed reads `?parent=` from its URL and refuses unless it is exactly
   one of the list (and, where the browser reports it, equal to
   `location.ancestorOrigins[0]`). It posts only to that one origin, so a page
   that lies about its origin receives nothing.

## Framing it

```html
<iframe
  src="https://stash.cloistr.xyz/embed/files?parent=https%3A%2F%2Fspace.cloistr.xyz&mode=pick"
  title="Stash files"
  style="width: 100%; border: 0"
></iframe>
```

| Parameter | Values | Meaning |
|-----------|--------|---------|
| `parent` | your exact origin | Required. Must be on the allow-list. |
| `mode` | `browse` (default), `pick` | `pick` adds checkboxes, Choose and Cancel. |

The embed accepts **no** messages from the parent. Everything it needs is in
its URL.

## Messages it sends

Every message is an object with `source: 'cloistr-stash-embed'` and
`version: 1`. Check `event.origin === 'https://stash.cloistr.xyz'` (your Stash
origin) and `event.source === iframe.contentWindow` before trusting one.

| `type` | Fields | When |
|--------|--------|------|
| `ready` | `signedIn: boolean` | Once sign-in has resolved, and again if it changes |
| `picked` | `items: PickedItem[]` | The user pressed Choose (pick mode) |
| `cancelled` | none | The user pressed Cancel (pick mode) |
| `resize` | `height: number` | Content height changed (CSS pixels); size the frame to it |

`PickedItem` is exactly `{ name, sha256, size, mimeType }`. `size` and
`mimeType` may be `null`. `sha256` is the hash of the **encrypted** blob: it
identifies the file, it does not open it. No key, file id or folder id is
ever sent.

```ts
window.addEventListener('message', (event) => {
  if (event.origin !== STASH_ORIGIN || event.source !== frame.contentWindow) return
  const msg = event.data
  if (msg?.source !== 'cloistr-stash-embed' || msg.version !== 1) return
  switch (msg.type) {
    case 'resize': frame.style.height = `${msg.height}px`; break
    case 'picked': onPicked(msg.items); break
    case 'cancelled': onCancel(); break
    case 'ready': if (!msg.signedIn) showSignInHint(); break
  }
})
```

## Sign-in

The embed uses the user's Stash session (same site, so the signer session is
shared). If the user is signed out it says so and offers "Sign in to Stash" in
a new tab, then "I have signed in" to reload the list. It never runs a sign-in
flow inside the frame.

## What the embed does not do (yet)

- No uploads, renames, moves or deletes: it is read-only.
- No share links. A picked item is a reference the user can open in Stash,
  not a link that opens the file for someone else.
- Items it cannot open (for example the signer is down and sealed items
  cannot be read) are counted on screen, never silently hidden.
