#!/usr/bin/env bash
set -euo pipefail

# crew installer
# Usage:
#   install.sh                — install for Claude Code (plugin system)
#   install.sh --codex        — install for Codex CLI (MCP + plugin)
#   install.sh --all          — install for both platforms
#   install.sh --uninstall    — remove from Claude Code
#   install.sh --uninstall-codex — remove from Codex CLI

INSTALL_DIR="$HOME/.crew"
REPO_URL="https://github.com/huypl53/agent-crew.git"
CODEX_CONFIG="$HOME/.codex/config.toml"
CODEX_PLUGINS_DIR="$HOME/.codex/.tmp/plugins/plugins"
CODEX_MARKETPLACE="$HOME/.codex/.tmp/plugins/.agents/plugins/marketplace.json"

CREW_TOOLS=(get_status join_room leave_room list_members list_rooms read_messages refresh send_message set_room_topic)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# --- Prerequisites ---

check_prereqs() {
  local missing=0
  command -v git  >/dev/null 2>&1 || { warn "git not found"; missing=1; }
  command -v bun  >/dev/null 2>&1 || { warn "bun not found — required runtime (https://bun.sh)"; missing=1; }
  command -v tmux >/dev/null 2>&1 || { warn "tmux not found — required for agent coordination"; missing=1; }
  if [ "$missing" -eq 1 ]; then fail "Missing required dependencies"; fi
}

# --- Clone / update repo ---

ensure_repo() {
  if [ -d "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    info "Updating $INSTALL_DIR..."
    cd "$(readlink -f "$INSTALL_DIR")"
    git pull --ff-only origin main 2>/dev/null || git pull --ff-only 2>/dev/null || true
  else
    info "Cloning crew to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi

  info "Installing dependencies..."
  cd "$(readlink -f "$INSTALL_DIR")/crew"
  bun install --frozen-lockfile 2>/dev/null || bun install
  bun link
}

# --- Claude Code ---

cmd_claude() {
  check_prereqs
  command -v claude >/dev/null 2>&1 || fail "claude not found — install Claude Code first"

  ensure_repo

  info "Registering crew marketplace..."
  claude plugins marketplace add "$INSTALL_DIR" 2>/dev/null && ok "Marketplace registered" || warn "Marketplace may already be registered"

  info "Installing crew plugin..."
  claude plugins install crew@crew-plugins 2>/dev/null && ok "Plugin installed" || warn "Plugin may already be installed"

  echo ""
  ok "crew installed for Claude Code!"
  echo ""
  echo "  Skills: /crew:join-room  /crew:boss  /crew:leader  /crew:worker  /crew:refresh"
  echo "  MCP tools: join_room, send_message, read_messages, list_rooms, ..."
  echo ""
  echo "  Dashboard: bun run --cwd $INSTALL_DIR/crew dashboard"
  echo ""
}

# --- Codex CLI ---

cmd_codex() {
  check_prereqs
  command -v codex >/dev/null 2>&1 || fail "codex not found — install Codex CLI first"

  ensure_repo

  # 1. Add MCP server
  info "Adding crew MCP server..."
  codex mcp remove crew 2>/dev/null || true
  codex mcp add crew -- bun run "$INSTALL_DIR/crew/src/index.ts" 2>/dev/null
  ok "MCP server registered"

  # 2. Add tool approval modes (required for --full-auto)
  info "Configuring tool approvals..."
  if [ -f "$CODEX_CONFIG" ]; then
    for tool in "${CREW_TOOLS[@]}"; do
      if ! grep -q "mcp_servers.crew.tools.${tool}" "$CODEX_CONFIG" 2>/dev/null; then
        cat >> "$CODEX_CONFIG" <<EOF

[mcp_servers.crew.tools.${tool}]
approval_mode = "approve"
EOF
      fi
    done
    ok "Tool approval modes configured"
  else
    warn "Could not find $CODEX_CONFIG — tool approvals not set"
  fi

  # 3. Symlink into plugin directory
  if [ -d "$CODEX_PLUGINS_DIR" ]; then
    info "Installing crew plugin..."
    rm -f "$CODEX_PLUGINS_DIR/crew"
    ln -s "$INSTALL_DIR/crew" "$CODEX_PLUGINS_DIR/crew"

    # 4. Add to marketplace.json if not already there
    if [ -f "$CODEX_MARKETPLACE" ] && ! grep -q '"crew"' "$CODEX_MARKETPLACE" 2>/dev/null; then
      python3 -c "
import json
with open('$CODEX_MARKETPLACE', 'r') as f:
    data = json.load(f)
data['plugins'].append({
    'name': 'crew',
    'source': {'source': 'local', 'path': './plugins/crew'},
    'policy': {'installation': 'INSTALLED_BY_DEFAULT', 'authentication': 'ON_INSTALL'},
    'category': 'Productivity'
})
with open('$CODEX_MARKETPLACE', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "Plugin added to marketplace" || warn "Could not update marketplace.json — add manually"
    else
      ok "Plugin already in marketplace"
    fi
  else
    warn "Codex plugins directory not found — plugin not symlinked (MCP tools still work)"
  fi

  echo ""
  ok "crew installed for Codex CLI!"
  echo ""
  echo "  Skills: crew:join-room  crew:boss  crew:leader  crew:worker  crew:refresh"
  echo "  MCP tools: join_room, send_message, read_messages, list_rooms, ..."
  echo ""
  echo "  Verify: codex → /plugins → crew should show 'Installed'"
  echo "  Dashboard: bun run --cwd $INSTALL_DIR/crew dashboard"
  echo ""
}

# --- Uninstall ---

cmd_uninstall_claude() {
  info "Removing crew from Claude Code..."

  if command -v claude >/dev/null 2>&1; then
    claude plugins uninstall crew@crew-plugins 2>/dev/null && ok "Plugin uninstalled" || warn "Plugin may not be installed"
  fi

  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed $INSTALL_DIR"
  fi

  echo ""
  ok "crew removed from Claude Code."
  echo ""
}

cmd_uninstall_codex() {
  info "Removing crew from Codex CLI..."

  if command -v codex >/dev/null 2>&1; then
    codex mcp remove crew 2>/dev/null && ok "MCP server removed" || warn "MCP server may not be registered"
  fi

  # Remove plugin symlink
  if [ -L "$CODEX_PLUGINS_DIR/crew" ]; then
    rm -f "$CODEX_PLUGINS_DIR/crew"
    ok "Plugin symlink removed"
  fi

  # Remove from marketplace.json
  if [ -f "$CODEX_MARKETPLACE" ] && grep -q '"crew"' "$CODEX_MARKETPLACE" 2>/dev/null; then
    python3 -c "
import json
with open('$CODEX_MARKETPLACE', 'r') as f:
    data = json.load(f)
data['plugins'] = [p for p in data['plugins'] if p.get('name') != 'crew']
with open('$CODEX_MARKETPLACE', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "Removed from marketplace" || warn "Could not update marketplace.json"
  fi

  # Remove tool approval entries from config.toml
  if [ -f "$CODEX_CONFIG" ]; then
    for tool in "${CREW_TOOLS[@]}"; do
      sed -i "/\[mcp_servers\.crew\.tools\.${tool}\]/,/approval_mode/d" "$CODEX_CONFIG" 2>/dev/null
    done
    # Remove empty crew plugin entry
    sed -i '/\[plugins\."crew@openai-curated"\]/,/enabled/d' "$CODEX_CONFIG" 2>/dev/null
    ok "Cleaned config.toml"
  fi

  echo ""
  ok "crew removed from Codex CLI."
  echo ""
}

# --- Main ---

case "${1:-}" in
  --codex)             cmd_codex ;;
  --all)               cmd_claude; cmd_codex ;;
  --uninstall)         cmd_uninstall_claude ;;
  --uninstall-codex)   cmd_uninstall_codex ;;
  --uninstall-all)     cmd_uninstall_claude; cmd_uninstall_codex ;;
  --help|-h)
    echo "crew installer"
    echo ""
    echo "Usage:"
    echo "  install.sh              Install for Claude Code"
    echo "  install.sh --codex      Install for Codex CLI"
    echo "  install.sh --all        Install for both platforms"
    echo "  install.sh --uninstall  Remove from Claude Code"
    echo "  install.sh --uninstall-codex  Remove from Codex CLI"
    echo "  install.sh --uninstall-all    Remove from both platforms"
    ;;
  "")                  cmd_claude ;;
  *)                   fail "Unknown option: $1. Use --help for usage." ;;
esac
