#!/bin/bash
# Rebuilds icon.png (the dev build's Dock icon) and Miks.icns (Miks.app's)
# from source.png, a full-bleed square at least 1024 pixels wide.
set -euo pipefail
cd "$(dirname "$0")"

swift make-icon.swift source.png icon.png

iconset=$(mktemp -d)/Miks.iconset
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o Miks.icns
rm -rf "$(dirname "$iconset")"
echo "Wrote icon.png and Miks.icns."
