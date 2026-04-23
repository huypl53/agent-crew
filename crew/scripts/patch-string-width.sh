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

# Portable in-place sed: BSD (macOS) requires -i '', GNU (Linux) requires -i
sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# Add cache declaration after segmenter
sedi 's/const segmenter = new Intl.Segmenter();/const segmenter = new Intl.Segmenter();\
const _widthCache = new Map();/' "$TARGET"

# Add cache lookup after ASCII fast path
sedi '/return string\.length;/{
N
s/return string\.length;\n\t}/return string.length;\
\t}\
\
\t\/\/ Module-level cache: avoid repeated Intl.Segmenter calls for the same string.\
\tconst cached = _widthCache.get(string);\
\tif (cached !== undefined) {\
\t\treturn cached;\
\t}/
}' "$TARGET"

# Store result before final return
sedi 's/	return width;/	_widthCache.set(string, width);\
	return width;/' "$TARGET"

echo "Patched string-width with module-level cache"
