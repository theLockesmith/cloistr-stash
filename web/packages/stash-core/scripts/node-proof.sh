#!/bin/sh
# Pack @cloistr/stash-core, install the tarball into an EMPTY directory (no
# workspace, no web app, no React), and run scripts/node-proof.mjs there.
#
#   cd web/packages/stash-core && npm run proof:node
set -eu

PKG_DIR=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/stash-core-node-proof.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

cd "$PKG_DIR"
npm run build --silent
TARBALL=$(npm pack --silent --pack-destination "$WORK")

cd "$WORK"
cp "$PKG_DIR/../../.npmrc" .npmrc
printf '{ "name": "stash-core-node-proof", "private": true, "type": "module" }\n' > package.json
# nostr-tools is already a transitive dep (via @cloistr/auth); naming it makes
# the proof's own signer import explicit. --omit=peer leaves optional React out.
npm install --silent --no-audit --no-fund --omit=peer "./$TARBALL" nostr-tools
cp "$PKG_DIR/scripts/node-proof.mjs" .
node node-proof.mjs
