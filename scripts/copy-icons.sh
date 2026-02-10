#!/bin/bash
# Copy icons from assets submodule to web directory
# Run this after cloning or when icons are updated

set -e

cd "$(dirname "$0")/.."

# Ensure submodule is initialized
if [ ! -d "assets/generated" ]; then
    echo "Initializing submodules..."
    git submodule update --init --recursive
fi

# Create target directory if needed
mkdir -p web

# Copy generated icons
cp assets/generated/drive/favicon.ico web/
cp assets/generated/drive/favicon.svg web/
cp assets/generated/drive/apple-touch-icon.png web/
cp assets/generated/drive/icon-192.png web/
cp assets/generated/drive/icon-512.png web/

echo "Icons copied to web/"
