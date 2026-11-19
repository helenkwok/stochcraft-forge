#!/bin/bash
# Builds the Jira bar script into static/stochcraft/jira-bar-<hash>.js and points index.html at it.
# The Forge CDN keeps serving an unchanged file name from its cache after a deploy, so the name carries the content hash.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
npx esbuild ui-src/bridge-entry.js --bundle --minify --format=iife --outfile="$tmp/jira-bar.js" >/dev/null
hash=$(shasum -a 256 "$tmp/jira-bar.js" | cut -c1-12)
rm -f static/stochcraft/jira-bar*.js
cp "$tmp/jira-bar.js" "static/stochcraft/jira-bar-$hash.js"
sed -i.bak -E "s#jira-bar(-[0-9a-f]+)?\.js#jira-bar-$hash.js#g" static/stochcraft/index.html && rm -f static/stochcraft/index.html.bak
echo "built static/stochcraft/jira-bar-$hash.js"
