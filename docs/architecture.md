# cc-tmux Architecture

## Overview

cc-tmux is a Claude Code MCP server plugin + TUI dashboard. Agents register into rooms with roles (boss/leader/worker) and communicate via tmux.

## Data Flow

```
Agent calls MCP tool
  → src/index.ts routes to tool handler in src/tools/
  → tool calls src/state/ for data operations
  → if send_message: tool calls src/delivery/
    → delivery calls state.addMessage() (always, NFR6)
    → delivery calls tmux.sendKeys() (push mode only)
  → tool returns MCP JSON response

Dashboard reads /tmp/cc-tmux/state/*.json via fs.watch
  → polls tmux capture-pane every 2s for status
  → renders 3-panel ANSI layout to stdout
```

## Module Boundaries

- **src/tools/** — One handler per MCP tool. Imports from state/tmux/delivery. Never calls another tool.
- **src/state/** — Owns all data. In-memory primary, JSON flush to `/tmp/cc-tmux/state/`. No other module reads/writes files.
- **src/tmux/** — Pure tmux CLI wrapper via Bun.spawn(). No business logic. Strips ANSI from capture-pane output.
- **src/delivery/** — Push (tmux send-keys) + pull (queue). Always queues first, then delivers.
- **src/shared/** — Types, status regex patterns. Used by both MCP server and dashboard.
- **src/dashboard/** — TUI modules. Reads state files (read-only), polls tmux, renders ANSI.
- **skills/** — Pure markdown. No code execution.

## Dependency Graph (acyclic)

```
tools → {state, delivery, tmux}
delivery → {state, tmux}
dashboard → {shared, tmux (for polling)}
state → tmux (for liveness validation)
```

## Key Patterns

- **Naming:** snake_case for MCP (tools, params, JSON), camelCase for TS, kebab-case for files
- **Messages:** Always queued to inbox before push delivery (NFR6/NFR9)
- **Push format:** `[sender@room]: text` via `tmux send-keys -l`
- **Status detection:** On-demand `capture-pane` + strip-ansi + regex match (idle/busy/dead/unknown)
- **State persistence:** Write-through JSON flush after every mutation
- **Error handling:** Tool handlers never throw — return `{ error: "..." }` with `isError: true`
- **Terminal safety:** Dashboard registers cleanup on SIGINT/SIGTERM/uncaughtException

## CC Status Line Regexes (from UAT)

| State | Pattern | Example |
|-------|---------|---------|
| Idle | `^❯\s*$` | Empty prompt |
| Busy | `/^[·*✶✽✻]\s+\w+…\s+\(\d/` | `· Contemplating… (3s)` |
| Complete | `/^✻\s+\w+\s+for\s+/` | `✻ Baked for 1m 2s` |
| Dead | `tmux list-panes #{pane_dead}` | Pane doesn't exist |

## Dashboard Panel Layout

```
Left (30%): Room/agent tree with collapse, status colors, multi-room badges
Right-top (70% x 65%): Chronological message feed, color-coded rooms
Right-bottom (70% x 35%): Selected agent details
```
