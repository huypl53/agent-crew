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
CODEX_PLUGINS_DIR="$HOME/.codex/plugins"
CODEX_MARKETPLACE_DIR="$HOME/.agents/plugins"
CODEX_MARKETPLACE="$CODEX_MARKETPLACE_DIR/marketplace.json"
ANTIGRAVITY_PLUGINS_DIR="$HOME/.gemini/config/plugins"

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
  echo "  Skills: /crew:join-room  /crew:leader  /crew:worker  /crew:refresh"
  echo "  MCP tools: join_room, send_message, read_messages, list_rooms, ..."
  echo ""
  echo ""
}

# --- Codex CLI ---

cmd_codex() {
  check_prereqs
  command -v codex >/dev/null 2>&1 || fail "codex not found — install Codex CLI first"

  ensure_repo

  mkdir -p "$CODEX_PLUGINS_DIR" "$CODEX_MARKETPLACE_DIR"

  info "Installing crew plugin..."
  rm -f "$CODEX_PLUGINS_DIR/crew"
  ln -s "$INSTALL_DIR/crew" "$CODEX_PLUGINS_DIR/crew"
  ok "Plugin symlinked"

  info "Updating Codex marketplace..."
  python3 -c "
import json
import os
path = '$CODEX_MARKETPLACE'
plugin = {
    'name': 'crew',
    'source': {'source': 'local', 'path': './.codex/plugins/crew'},
    'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
    'category': 'Productivity',
}
data = {
    'name': 'local-crew-plugins',
    'interface': {'displayName': 'Local Crew Plugins'},
    'plugins': [],
}
if os.path.exists(path):
    try:
        with open(path, 'r') as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            if isinstance(loaded.get('interface'), dict):
                data['interface'].update(loaded['interface'])
            if isinstance(loaded.get('plugins'), list):
                data['plugins'] = loaded['plugins']
    except Exception:
        pass
if not any(p.get('name') == 'crew' for p in data['plugins']):
    data['plugins'].append(plugin)
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "Marketplace updated" || warn "Could not update marketplace.json — add manually"

  echo ""
  ok "crew installed for Codex CLI!"
  echo ""
  echo "  Skills: crew:join-room  crew:leader  crew:worker  crew:refresh"
  echo ""
  echo "  Verify: codex → /plugins → crew should show 'Installed'"
  echo ""
}

# --- Antigravity ---

cmd_antigravity() {
  check_prereqs
  command -v agy >/dev/null 2>&1 || warn "agy CLI not found in PATH — installing plugin anyway"

  ensure_repo

  local target_dir="$ANTIGRAVITY_PLUGINS_DIR/huypl53.crew"
  info "Installing crew plugin for Antigravity at $target_dir..."
  mkdir -p "$target_dir"

  # Expose manifest and hooks
  rm -f "$target_dir/plugin.json"
  ln -s "$INSTALL_DIR/crew/.antigravity-plugin/plugin.json" "$target_dir/plugin.json"

  rm -f "$target_dir/hooks.json"
  ln -s "$INSTALL_DIR/crew/.antigravity-plugin/hooks.json" "$target_dir/hooks.json"

  # Expose skills
  rm -f "$target_dir/skills"
  ln -s "$INSTALL_DIR/crew/skills" "$target_dir/skills"

  ok "Antigravity plugin files linked successfully"

  echo ""
  ok "crew installed for Antigravity!"
  echo ""
  echo "  Skills: /crew:join-room  /crew:leader  /crew:worker  /crew:refresh"
  echo "  Hooks: Stop, UserPromptSubmit (calls: crew hook-event --json)"
  echo ""
}

cmd_antigravity_project() {
  check_prereqs
  local target_project_dir="${2:-$(pwd)}"
  local agents_dir="$target_project_dir/.agents"

  ensure_repo

  info "Installing crew plugin for Antigravity in project scope at $target_project_dir..."
  mkdir -p "$agents_dir/skills"

  # Expose skills
  for skill in join-room leader party refresh worker; do
    rm -rf "$agents_dir/skills/$skill"
    ln -s "$INSTALL_DIR/crew/skills/$skill" "$agents_dir/skills/$skill"
  done

  # Configure/merge hooks.json
  local hooks_file="$agents_dir/hooks.json"
  if [ -f "$hooks_file" ]; then
    info "Merging crew hooks into existing hooks.json..."
    python3 -c "
import json
try:
    with open('$hooks_file', 'r') as f:
        data = json.load(f)
except Exception:
    data = {}

data['crew-hooks'] = {
    'UserPromptSubmit': [{
        'matcher': '',
        'hooks': [{'type': 'command', 'command': 'crew hook-event --json || true'}]
    }],
    'Stop': [{
        'matcher': '',
        'hooks': [{'type': 'command', 'command': 'crew hook-event --json || true'}]
    }]
}

with open('$hooks_file', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "Merged hooks successfully" || warn "Could not merge hooks.json — please add manually"
  else
    info "Creating new hooks.json..."
    cat > "$hooks_file" <<'EOF'
{
  "crew-hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "crew hook-event --json || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "crew hook-event --json || true"
          }
        ]
      }
    ]
  }
}
EOF
    ok "Created hooks.json"
  fi

  echo ""
  ok "crew installed for Antigravity in project scope!"
  echo ""
  echo "  Skills: /crew:join-room  /crew:leader  /crew:worker  /crew:refresh"
  echo "  Hooks: Stop, UserPromptSubmit (calls: crew hook-event --json)"
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

  # Remove plugin symlink
  if [ -L "$CODEX_PLUGINS_DIR/crew" ]; then
    rm -f "$CODEX_PLUGINS_DIR/crew"
    ok "Plugin symlink removed"
  fi

  # Remove from marketplace.json
  if [ -f "$CODEX_MARKETPLACE" ]; then
    python3 -c "
import json
path = '$CODEX_MARKETPLACE'
try:
    with open(path, 'r') as f:
        data = json.load(f)
except Exception:
    raise SystemExit(0)
if isinstance(data, dict) and isinstance(data.get('plugins'), list):
    data['plugins'] = [p for p in data['plugins'] if p.get('name') != 'crew']
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
" 2>/dev/null && ok "Removed from marketplace" || warn "Could not update marketplace.json"
  fi

  echo ""
  ok "crew removed from Codex CLI."
  echo ""
}

cmd_uninstall_antigravity() {
  info "Removing crew from Antigravity..."

  local target_dir="$ANTIGRAVITY_PLUGINS_DIR/huypl53.crew"
  if [ -d "$target_dir" ] || [ -L "$target_dir" ]; then
    rm -rf "$target_dir"
    ok "Removed $target_dir"
  fi

  echo ""
  ok "crew removed from Antigravity."
  echo ""
}

cmd_uninstall_antigravity_project() {
  local target_project_dir="${2:-$(pwd)}"
  local agents_dir="$target_project_dir/.agents"

  info "Removing crew from Antigravity in project scope at $target_project_dir..."

  # Remove skills symlinks
  for skill in join-room leader party refresh worker; do
    if [ -L "$agents_dir/skills/$skill" ] || [ -d "$agents_dir/skills/$skill" ]; then
      rm -rf "$agents_dir/skills/$skill"
    fi
  done

  # Clean up hooks.json
  local hooks_file="$agents_dir/hooks.json"
  if [ -f "$hooks_file" ]; then
    python3 -c "
import json
try:
    with open('$hooks_file', 'r') as f:
        data = json.load(f)
    if 'crew-hooks' in data:
        del data['crew-hooks']
    with open('$hooks_file', 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
except Exception:
    pass
" 2>/dev/null && ok "Removed crew hooks from hooks.json" || warn "Could not clean hooks.json"
  fi

  echo ""
  ok "crew removed from Antigravity project scope."
  echo ""
}

# --- Main ---

case "${1:-}" in
  --codex)             cmd_codex ;;
  --antigravity|--agy) cmd_antigravity ;;
  --antigravity-project|--agy-project) cmd_antigravity_project "$@" ;;
  --all)               cmd_claude; cmd_codex; cmd_antigravity ;;
  --uninstall)         cmd_uninstall_claude ;;
  --uninstall-codex)   cmd_uninstall_codex ;;
  --uninstall-antigravity|--uninstall-agy) cmd_uninstall_antigravity ;;
  --uninstall-antigravity-project|--uninstall-agy-project) cmd_uninstall_antigravity_project "$@" ;;
  --uninstall-all)     cmd_uninstall_claude; cmd_uninstall_codex; cmd_uninstall_antigravity ;;
  --help|-h)
    echo "crew installer"
    echo ""
    echo "Usage:"
    echo "  install.sh                    Install for Claude Code"
    echo "  install.sh --codex            Install for Codex CLI"
    echo "  install.sh --agy              Install for Antigravity (global)"
    echo "  install.sh --agy-project [dir] Install for Antigravity (project scope)"
    echo "  install.sh --all              Install for all supported platforms"
    echo "  install.sh --uninstall        Remove from Claude Code"
    echo "  install.sh --uninstall-codex  Remove from Codex CLI"
    echo "  install.sh --uninstall-agy    Remove from Antigravity (global)"
    echo "  install.sh --uninstall-agy-project [dir] Remove from Antigravity (project scope)"
    echo "  install.sh --uninstall-all    Remove from all platforms"
    ;;
  "")                  cmd_claude ;;
  *)                   fail "Unknown option: $1. Use --help for usage." ;;
esac
