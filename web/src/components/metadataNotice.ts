// What a file's metadata gives away, in the user's terms. Two shapes exist
// (stash-core drive.ts): old-shape events carry name, size, type and a hash of
// the unencrypted file in the clear; sealed events keep all of that inside the
// seal (stash-core sealed.ts), leaving only the event's timestamps on the relay
// and the encrypted blob's size on Blossom.

export interface MetadataNotice {
  heading: string
  body: string
}

export function metadataNotice(file: Record<string, unknown>): MetadataNotice {
  if (file.sealed === true) {
    return {
      heading: 'Still visible',
      body:
        "This file's name, size, type and tags, and its folder's name, are encrypted " +
        'too. Anyone who looks up your public key can still see how many items you ' +
        'store, when they changed, and the size of the encrypted file on the storage ' +
        'server, which is close to the original size.',
    }
  }
  return {
    heading: 'Not encrypted yet',
    body:
      "This file's name, size and type, its folder's name, and a hash of its " +
      'unencrypted contents are stored readable on the Nostr relay. Anyone who ' +
      'looks up your public key can see them.',
  }
}

export function e2eBadgeTitle(file: Record<string, unknown>): string {
  return file.sealed === true
    ? 'Contents, name, size and type end-to-end encrypted (XChaCha20-Poly1305).'
    : 'Contents end-to-end encrypted (XChaCha20-Poly1305). The name, size and type are not encrypted yet.'
}
