# cc-tmux Installer Design

## Overview

Single `install.sh` script that supports both user-scope (global) and project-scope installation. Distributed via `curl|sh` from GitHub.

## Install Modes

### User scope (default)

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/cc-tmux/main/install.sh | sh
```

1. Clone repo to `~/.cc-tmux/`
2. Run `bun install` in `~/.cc-tmux/`
3. Copy 4 skills to `~/.claude/skills/cc-tmux-{join-room,boss,leader,worker}/`
4. Add `cc-tmux` MCP server entry to `~/.claude/settings.json` mcpServers
5. Print success message with usage instructions

MCP server config points to `~/.cc-tmux/src/index.ts`:
```json
{
  "mcpServers": {
    "cc-tmux": {
      "command": "bun",
      "args": ["run", "~/.cc-tmux/src/index.ts"]
    }
  }
}
```

### Project scope

```bash
~/.cc-tmux/install.sh --project
```

Run from within a project directory:

1. Copy 4 skills to `.claude/skills/cc-tmux-{join-room,boss,leader,worker}/`
2. Create or merge `.mcp.json` with cc-tmux server entry (path to `~/.cc-tmux/src/index.ts`)
3. Print success message

### Uninstall

```bash
~/.cc-tmux/install.sh --uninstall          # user scope
~/.cc-tmux/install.sh --uninstall-project   # project scope (run from project dir)
```

User uninstall:
- Remove skills from `~/.claude/skills/cc-tmux-*/`
- Remove `cc-tmux` entry from `~/.claude/settings.json` mcpServers
- Remove `~/.cc-tmux/` directory

Project uninstall:
- Remove `.claude/skills/cc-tmux-*/` from cwd
- Remove `cc-tmux` entry from `.mcp.json` in cwd (delete file if empty)

## Scope Resolution

| Scope | Skills | MCP Config | Availability |
|-------|--------|------------|-------------|
| User | `~/.claude/skills/cc-tmux-*/` | `~/.claude/settings.json` | All CC sessions |
| Project | `.claude/skills/cc-tmux-*/` | `.mcp.json` | Project only |

Project scope takes precedence when both are installed (CC's normal resolution).

## Prerequisites

The script checks for and reports missing:
- `bun` — required runtime
- `tmux` — required for agent coordination
- `git` — required for cloning
- `claude` — optional, just warns

## Design Decisions

- **No npm publish** — overkill for copying ~10 files
- **Clone full repo** — ensures skills, source, and tests are all available; easy to update via `git pull`
- **Absolute paths in .mcp.json** — `~/.cc-tmux/src/index.ts` so it works from any project directory
- **Merge, don't overwrite** — `.mcp.json` and `settings.json` may have other entries; use jq or simple JSON merge
- **Update via `git pull`** — `~/.cc-tmux/install.sh --update` pulls latest and re-copies skills
