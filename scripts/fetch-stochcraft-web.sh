#!/bin/bash
# Copies StochCraft's published browser build into static/stochcraft (index.html is this app's own and is kept).
set -euo pipefail
cd "$(dirname "$0")/.."
base=https://helenkwok.github.io/StochCraft
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -sfL "$base/" -o "$tmp/index.html"
js=$(grep -o 'stochcraft-web-[0-9a-f]*\.js' "$tmp/index.html" | head -1)
wasm=${js%.js}_bg.wasm
mkdir -p static/stochcraft/snippets
for f in "$js" "$wasm" stochcraft-worker.js stochcraft-worker_bg.wasm stochcraft-worker_loader.js icon.svg; do
  curl -sfL "$base/$f" -o "static/stochcraft/$f"; echo "fetched $f"
done
for s in $(grep -o 'snippets/[^"]*\.js' "$tmp/index.html" | sort -u); do
  mkdir -p "static/stochcraft/$(dirname "$s")"; curl -sfL "$base/$s" -o "static/stochcraft/$s"; echo "fetched $s"
done
# index.html names the hashed files: point this app's copy at the ones just fetched.
sed -i.bak -E "s#stochcraft-web-[0-9a-f]+(_bg\.wasm|\.js)#${js%.js}\1#g" static/stochcraft/index.html && rm -f static/stochcraft/index.html.bak
