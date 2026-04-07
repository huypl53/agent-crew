#!/bin/bash
# Patch string-width to add module-level caching for Intl.Segmenter results.
# Bun's Intl.Segmenter is ~500x slower than ASCII fast path. Without this cache,
# Ink render takes ~440ms/frame; with it, ~15ms/frame.
#
# Applied automatically via postinstall. Re-run after bun install if needed.

set -e
TARGET="node_modules/string-width/index.js"

if [ ! -f "$TARGET" ]; then
  echo "string-width not found, skipping patch"
  exit 0
fi

if grep -q '_widthCache' "$TARGET"; then
  exit 0  # Already patched
fi

# Add cache declaration after segmenter
sed -i 's/const segmenter = new Intl.Segmenter();/const segmenter = new Intl.Segmenter();\nconst _widthCache = new Map();/' "$TARGET"

# Add cache lookup after ASCII fast path
sed -i '/return string.length;/,/^$/{
  /^$/a\\n\t\/\/ Module-level cache: avoid repeated Intl.Segmenter calls for the same string.\n\tconst cached = _widthCache.get(string);\n\tif (cached !== undefined) {\n\t\treturn cached;\n\t}
}' "$TARGET"

# Store result before final return
sed -i 's/\treturn width;$/\t_widthCache.set(string, width);\n\treturn width;/' "$TARGET"

echo "Patched string-width with module-level cache"
