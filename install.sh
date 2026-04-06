#!/usr/bin/env bash
set -euo pipefail

# cc-tmux installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OWNER/cc-tmux/main/install.sh | sh
#   install.sh              — install globally (user scope)
#   install.sh --project    — install into current project
#   install.sh --uninstall  — remove global install
#   install.sh --uninstall-project — remove from current project
#   install.sh --update     — pull latest and re-copy skills

INSTALL_DIR="$HOME/.cc-tmux"
REPO_URL="https://github.com/OWNER/cc-tmux.git"
SKILLS=(join-room boss leader worker)
CLAUDE_JSON="$HOME/.claude.json"

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
  command -v git  >/dev/null 2>&1 || { warn "git not found — required for installation"; missing=1; }
  command -v bun  >/dev/null 2>&1 || { warn "bun not found — required runtime (https://bun.sh)"; missing=1; }
  command -v tmux >/dev/null 2>&1 || { warn "tmux not found — required for agent coordination"; missing=1; }
  command -v claude >/dev/null 2>&1 || warn "claude not found — install Claude Code to use cc-tmux"
  if [ "$missing" -eq 1 ]; then fail "Missing required dependencies"; fi
}

# --- JSON helpers (no jq dependency) ---

# Merge an MCP server entry into a JSON file's mcpServers object
# Usage: merge_mcp_server <file> <server_name> <json_value>
merge_mcp_server() {
  local file="$1" name="$2" value="$3"

  if [ ! -f "$file" ]; then
    # Create new file with just mcpServers
    cat > "$file" <<JSONEOF
{
  "mcpServers": {
    "$name": $value
  }
}
JSONEOF
    return
  fi

  # Use python3 (available on macOS + Linux) for safe JSON merge
  python3 -c "
import json, sys
with open('$file', 'r') as f:
    data = json.load(f)
if 'mcpServers' not in data:
    data['mcpServers'] = {}
data['mcpServers']['$name'] = json.loads('''$value''')
with open('$file', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
}

# Remove an MCP server entry from a JSON file
# Usage: remove_mcp_server <file> <server_name>
remove_mcp_server() {
  local file="$1" name="$2"
  [ ! -f "$file" ] && return

  python3 -c "
import json
with open('$file', 'r') as f:
    data = json.load(f)
if 'mcpServers' in data and '$name' in data['mcpServers']:
    del data['mcpServers']['$name']
    if not data['mcpServers']:
        del data['mcpServers']
with open('$file', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
}

# --- Skill operations ---

install_skills() {
  local target_dir="$1"
  mkdir -p "$target_dir"
  for skill in "${SKILLS[@]}"; do
    local src="$INSTALL_DIR/skills/$skill/SKILL.md"
    local dst="$target_dir/cc-tmux-$skill"
    mkdir -p "$dst"
    cp "$src" "$dst/SKILL.md"
  done
}

remove_skills() {
  local target_dir="$1"
  for skill in "${SKILLS[@]}"; do
    rm -rf "$target_dir/cc-tmux-$skill"
  done
}

# --- MCP server JSON value ---

mcp_server_value() {
  cat <<JSONEOF
{
      "command": "bun",
      "args": ["run", "$INSTALL_DIR/src/index.ts"]
    }
JSONEOF
}

# --- Commands ---

cmd_install() {
  check_prereqs

  info "Installing cc-tmux to $INSTALL_DIR..."

  if [ -d "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists — updating instead"
    cd "$(readlink -f "$INSTALL_DIR")"
    git pull --ff-only origin main 2>/dev/null || git pull --ff-only 2>/dev/null || true
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi

  info "Installing dependencies..."
  cd "$(readlink -f "$INSTALL_DIR")"
  bun install --frozen-lockfile 2>/dev/null || bun install

  info "Installing skills to ~/.claude/skills/..."
  install_skills "$HOME/.claude/skills"

  info "Adding MCP server to ~/.claude.json..."
  merge_mcp_server "$CLAUDE_JSON" "cc-tmux" "$(mcp_server_value)"

  echo ""
  ok "cc-tmux installed globally!"
  echo ""
  echo "  Skills available in all CC sessions:"
  echo "    /cc-tmux-join-room  — Register as boss/leader/worker"
  echo "    /cc-tmux-boss       — Boss coordination patterns"
  echo "    /cc-tmux-leader     — Leader management patterns"
  echo "    /cc-tmux-worker     — Worker task patterns"
  echo ""
  echo "  MCP tools: join_room, leave_room, list_rooms, list_members,"
  echo "             send_message, read_messages, get_status"
  echo ""
  echo "  Optional: install into a specific project:"
  echo "    cd your-project && $INSTALL_DIR/install.sh --project"
  echo ""
}

cmd_local() {
  check_prereqs

  # Resolve the directory containing this script
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  info "Installing cc-tmux locally from $script_dir..."

  if [ -d "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ]; then
    fail "$INSTALL_DIR exists and is not a symlink. Remove it first or use --uninstall."
  fi

  # Symlink ~/.cc-tmux → local repo
  rm -f "$INSTALL_DIR"
  ln -sfn "$script_dir" "$INSTALL_DIR"
  ok "Symlinked $INSTALL_DIR → $script_dir"

  info "Installing dependencies..."
  cd "$script_dir"
  bun install --frozen-lockfile 2>/dev/null || bun install

  info "Installing skills to ~/.claude/skills/..."
  install_skills "$HOME/.claude/skills"

  info "Adding MCP server to ~/.claude.json..."
  merge_mcp_server "$CLAUDE_JSON" "cc-tmux" "$(mcp_server_value)"

  echo ""
  ok "cc-tmux installed locally!"
  echo ""
  echo "  Linked: $INSTALL_DIR → $script_dir"
  echo ""
  echo "  Skills available in all CC sessions:"
  echo "    /cc-tmux-join-room  — Register as boss/leader/worker"
  echo "    /cc-tmux-boss       — Boss coordination patterns"
  echo "    /cc-tmux-leader     — Leader management patterns"
  echo "    /cc-tmux-worker     — Worker task patterns"
  echo ""
  echo "  MCP tools: join_room, leave_room, list_rooms, list_members,"
  echo "             send_message, read_messages, get_status"
  echo ""
  echo "  Per-project install:  cd your-project && $INSTALL_DIR/install.sh --project"
  echo "  Uninstall:            $INSTALL_DIR/install.sh --uninstall"
  echo ""
}

cmd_project() {
  if [ ! -d "$INSTALL_DIR" ]; then
    fail "cc-tmux not installed globally. Run install.sh first (without --project)"
  fi

  local project_dir
  project_dir="$(pwd)"

  info "Installing cc-tmux into project: $project_dir"

  info "Copying skills to .claude/skills/..."
  install_skills "$project_dir/.claude/skills"

  info "Adding MCP server to .mcp.json..."
  merge_mcp_server "$project_dir/.mcp.json" "cc-tmux" "$(mcp_server_value)"

  echo ""
  ok "cc-tmux installed in project!"
  echo "  Skills: .claude/skills/cc-tmux-*/"
  echo "  MCP:    .mcp.json"
  echo ""
  echo "  Commit these files so teammates get cc-tmux too."
  echo ""
}

cmd_uninstall() {
  info "Removing cc-tmux global install..."

  remove_skills "$HOME/.claude/skills"
  ok "Removed skills from ~/.claude/skills/"

  remove_mcp_server "$CLAUDE_JSON" "cc-tmux"
  ok "Removed MCP server from ~/.claude.json"

  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed $INSTALL_DIR"
  fi

  echo ""
  ok "cc-tmux uninstalled."
  echo ""
}

cmd_uninstall_project() {
  local project_dir
  project_dir="$(pwd)"

  info "Removing cc-tmux from project: $project_dir"

  remove_skills "$project_dir/.claude/skills"
  ok "Removed skills from .claude/skills/"

  remove_mcp_server "$project_dir/.mcp.json" "cc-tmux"
  ok "Removed MCP server from .mcp.json"

  # Clean up empty .mcp.json
  if [ -f "$project_dir/.mcp.json" ]; then
    local content
    content="$(python3 -c "
import json
with open('$project_dir/.mcp.json') as f:
    d = json.load(f)
# Remove if only empty object or only has empty mcpServers
if not d or d == {} or d == {'mcpServers': {}}:
    print('empty')
else:
    print('keep')
" 2>/dev/null || echo 'keep')"
    if [ "$content" = "empty" ]; then
      rm "$project_dir/.mcp.json"
      ok "Removed empty .mcp.json"
    fi
  fi

  echo ""
  ok "cc-tmux removed from project."
  echo ""
}

cmd_update() {
  if [ ! -d "$INSTALL_DIR" ]; then
    fail "cc-tmux not installed. Run install.sh first"
  fi

  info "Updating cc-tmux..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || git pull --ff-only 2>/dev/null || fail "Failed to pull updates"

  info "Updating dependencies..."
  bun install --frozen-lockfile 2>/dev/null || bun install

  info "Updating skills..."
  install_skills "$HOME/.claude/skills"

  echo ""
  ok "cc-tmux updated!"
  echo ""
}

# --- Main ---

case "${1:-}" in
  --local)             cmd_local ;;
  --project)           cmd_project ;;
  --uninstall)         cmd_uninstall ;;
  --uninstall-project) cmd_uninstall_project ;;
  --update)            cmd_update ;;
  --help|-h)
    echo "cc-tmux installer"
    echo ""
    echo "Usage:"
    echo "  install.sh              Install globally (git clone)"
    echo "  install.sh --local      Install from local repo (symlink)"
    echo "  install.sh --project    Install into current project"
    echo "  install.sh --uninstall  Remove global install"
    echo "  install.sh --uninstall-project  Remove from current project"
    echo "  install.sh --update     Pull latest and re-copy skills"
    ;;
  "")                  cmd_install ;;
  *)                   fail "Unknown option: $1. Use --help for usage." ;;
esac
