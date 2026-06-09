#!/usr/bin/env bash
# Run once after cloning to activate git hooks stored in .githooks/
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "⚙️  Configuring git hooks..."

# Point git to the tracked hooks directory
git -C "$REPO_ROOT" config core.hooksPath "$REPO_ROOT/.githooks"

# Ensure all hooks are executable
chmod +x "$REPO_ROOT"/.githooks/*

echo "✅ Git hooks activated from .githooks/"
echo ""
echo "Active hooks:"
for f in "$REPO_ROOT"/.githooks/*; do
  echo "  • $(basename "$f")"
done
