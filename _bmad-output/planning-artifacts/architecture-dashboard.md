---
stepsCompleted: ['step-01-init', 'step-02-context', 'step-03-starter', 'step-04-decisions', 'step-05-patterns', 'step-06-structure', 'step-07-validation', 'step-08-complete']
inputDocuments:
  - '_bmad-output/planning-artifacts/prd-dashboard.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-04-05-1800.md'
  - '_bmad-output/planning-artifacts/architecture.md'
workflowType: 'architecture'
project_name: 'cc-tmux-dashboard'
user_name: 'lee'
date: '2026-04-06'
status: 'complete'
completedAt: '2026-04-06'
---

# Architecture Decision Document — cc-tmux TUI Dashboard

_Extension of the cc-tmux MCP server plugin. The dashboard is a separate process in the same repo that reads state files and polls tmux for live agent observation._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
32 FRs across 8 capability areas:
- **State Reading (FR1-5):** Read agents/rooms/messages JSON, fs.watch, retry on parse error
- **Status Detection (FR6-9):** Batch capture-pane every 2s, idle/busy/dead regex, ANSI strip
- **Tree Panel (FR10-13):** Collapsible rooms, primary room listing, multi-room badges, color-coded status
- **Message Feed (FR14-18):** Chronological mixed feed, color-coded rooms, broadcast display, auto-scroll
- **Details Panel (FR19-21):** Full agent info, auto-select most recently changed, arrow key selection
- **Navigation (FR22-24):** Arrow key nav, selection highlight, clean quit
- **Rendering (FR25-29):** 3-panel ANSI layout, alternate screen, full redraw, SIGWINCH, box drawing
- **Lifecycle (FR30-32):** Start without server, survive restarts, detect missing state dir

**Non-Functional Requirements:**
12 NFRs:
- **Performance (NFR1-4):** Render cycle <1s, batch polling <500ms, startup <1s, stable memory
- **Reliability (NFR5-8):** JSON error resilience, dead pane handling, terminal restore, read-only guarantee
- **Compatibility (NFR9-12):** 80x24 minimum, tmux 3.0+, Linux/macOS, ANSI 256-color

**Scale & Complexity:**
- Low complexity — file reader + tmux poller + ANSI renderer
- 6 source modules + 1 entrypoint
- Zero external dependencies beyond what cc-tmux already has

### Technical Constraints & Dependencies

- **Runtime:** Bun (shared with MCP server)
- **Rendering:** Raw ANSI escape codes — no TUI framework
- **Data source:** JSON files in `/tmp/cc-tmux/state/` (read-only)
- **Status source:** `tmux capture-pane` + `tmux list-panes` (shared with MCP server)
- **Shared code:** Imports types, tmux wrapper, and status regex from MCP server modules
- **Terminal:** Requires ANSI 256-color support, alternate screen buffer, raw mode

### Cross-Cutting Concerns

- **Terminal state safety:** Must restore terminal on any exit path (clean, crash, signal)
- **ANSI stripping:** Same strip-ansi usage as MCP server for capture-pane output
- **File read safety:** Retry on JSON parse error, last known state fallback
- **Resize handling:** SIGWINCH → recalculate all panel dimensions → full redraw

## Starter Template Evaluation

### Selected Approach: Extension of Existing cc-tmux Project

No separate project. Dashboard lives in `src/dashboard/` within the cc-tmux repo. Shares `package.json`, `tsconfig.json`, and existing modules.

**No new dependencies.** Raw ANSI rendering with Bun's built-in terminal I/O. The `strip-ansi` dep already exists for the MCP server.

## Core Architectural Decisions

### Data Architecture

**No state of its own.** The dashboard reads cc-tmux state files and holds transient display state in memory:

- `lastKnownState: { agents, rooms, messages }` — parsed from JSON files, refreshed on fs.watch
- `agentStatuses: Map<string, Status>` — refreshed every 2s poll cycle from tmux
- `selectedAgent: string | null` — keyboard nav state
- `collapsedRooms: Set<string>` — tree UI state
- `messageBuffer: Message[]` — last 500 messages for feed display

**File read strategy:**
- `fs.watch()` on `/tmp/cc-tmux/state/` for change notifications
- On notification: read file, `JSON.parse()`, if error retry once, else keep lastKnownState
- State files written atomically by MCP server (temp + rename)

### Rendering Architecture

**Full redraw on alternate screen buffer.**

Render cycle (every 2s or on file change):
1. Read state files (if changed)
2. Batch tmux capture-pane for all agents
3. Build screen buffer as string (panel by panel)
4. Write entire buffer to stdout in one `process.stdout.write()` call
5. Position cursor

**Terminal management:**
- Enter: `\x1b[?1049h` (alternate screen) + raw mode (`process.stdin.setRawMode(true)`)
- Exit: `\x1b[?1049l` (restore screen) + cooked mode
- Cleanup handlers on: `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`, `unhandledRejection`

**Panel layout calculation:**
```
Terminal width: W, height: H

Left panel:  x=0,       w=floor(W*0.3), h=H
Right-top:   x=left.w,  w=W-left.w,     h=floor(H*0.65)
Right-bottom: x=left.w, w=W-left.w,     h=H-right_top.h
```

Fixed 30/70 horizontal split, 65/35 vertical split on the right side.

### Status Polling Architecture

**Batch cycle every 2 seconds:**
```
for each agent in agents.json:
  spawn `tmux list-panes -t {target} -F '#{pane_dead}'`
  if dead → status = "dead"
  else → spawn `tmux capture-pane -t {target} -p`
       → strip ANSI → match CC regex → idle/busy/unknown
```

All spawns sequential (not parallel) to avoid tmux command contention. 20 agents × ~25ms per capture = ~500ms total.

### Keyboard Input Architecture

**Raw mode stdin processing:**
- Read byte sequences from `process.stdin`
- Parse arrow keys: `\x1b[A` (up), `\x1b[B` (down)
- Parse quit: `q` (0x71), `Ctrl+C` (0x03)
- Ignore all other input (read-only)

**Navigation:**
- Up/down moves selection in flattened tree (rooms + agents interleaved)
- Selection persists across redraws unless auto-select triggers (most recently changed agent)
- Manual selection disables auto-select until next status change

### API & Communication Patterns

**No API.** The dashboard has no communication with the MCP server. Data flow is:

```
MCP Server → writes → /tmp/cc-tmux/state/*.json → reads → Dashboard
tmux panes → capture-pane → Dashboard
Keyboard → stdin → Dashboard
Dashboard → ANSI → stdout → Terminal
```

### Infrastructure & Deployment

**Launch:** `bun run src/dashboard.ts`
**Package.json script:** `"dashboard": "bun run src/dashboard.ts"`
**No separate binary, no separate package.**

## Implementation Patterns & Consistency Rules

### Naming Patterns

Same conventions as MCP server:
- Files: `kebab-case.ts`
- Functions: `camelCase`
- Types: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`

### Module Boundaries

- `dashboard/terminal.ts` — Raw terminal management. Alternate screen, raw mode, resize, cleanup. No rendering logic.
- `dashboard/status.ts` — Batch tmux polling. Returns `Map<agentName, Status>`. No rendering.
- `dashboard/tree.ts` — Tree data structure from agents/rooms. Handles selection, collapse. No rendering.
- `dashboard/feed.ts` — Message formatting and buffer management. No rendering.
- `dashboard/render.ts` — ANSI string building for all panels. Consumes tree, feed, status. Outputs string.
- `dashboard/app.ts` — Main loop: orchestrates read → poll → render → write. Handles input events.

**Key rule:** Only `render.ts` produces ANSI escape codes. Only `terminal.ts` writes to stdout. Only `status.ts` calls tmux. Only `app.ts` orchestrates the cycle.

### ANSI Rendering Patterns

**Box drawing characters:**
```
┌─ Title ──────┐
│ content      │
└──────────────┘
```
Use `─` (U+2500), `│` (U+2502), `┌` (U+250C), `┐` (U+2510), `└` (U+2514), `┘` (U+2518).

**Colors:**
```typescript
const COLORS = {
  green: '\x1b[32m',   // idle
  yellow: '\x1b[33m',  // busy
  red: '\x1b[31m',     // dead
  gray: '\x1b[90m',    // unknown
  cyan: '\x1b[36m',    // room names in feed
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  inverse: '\x1b[7m',  // selected item highlight
} as const;
```

**Cursor positioning:** `\x1b[{row};{col}H` (1-indexed)

### Process Patterns

**Error handling:**
- JSON parse error: retry once, fallback to lastKnownState, render "(stale)" indicator
- tmux command failure: mark agent as "unknown", continue batch
- Terminal write error: log to stderr, continue
- Never crash the dashboard from a data error

**Cleanup pattern:**
```typescript
function cleanup() {
  process.stdout.write('\x1b[?1049l');  // restore screen
  process.stdin.setRawMode(false);       // restore terminal
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (e) => { cleanup(); console.error(e); });
```

## Project Structure & Boundaries

### Complete Directory Structure (Dashboard Addition)

```
src/
├── dashboard.ts                # Entrypoint: parse args, start app
├── dashboard/
│   ├── app.ts                  # Main loop: poll → read → render → write cycle
│   ├── render.ts               # ANSI string builder: tree panel, feed panel, details panel
│   ├── tree.ts                 # Room/agent tree: build from state, selection, collapse
│   ├── feed.ts                 # Message feed: format, buffer, scroll
│   ├── status.ts               # Batch tmux capture-pane + status regex matching
│   └── terminal.ts             # Terminal management: alternate screen, raw mode, resize, cleanup
├── shared/
│   ├── types.ts                # Shared types: Agent, Room, Message, Status (used by MCP + dashboard)
│   ├── tmux.ts                 # Shared tmux wrapper: capturePane, isPaneDead, validateTmux
│   └── status-patterns.ts      # Shared CC status line regex patterns
├── tools/                      # ...existing MCP tool handlers
├── state/                      # ...existing state module
├── delivery/                   # ...existing delivery module
└── index.ts                    # ...existing MCP server entrypoint
```

**Refactoring note:** The shared types, tmux wrapper, and status patterns currently live in `src/tmux/index.ts` and `src/state/index.ts`. They should be extracted to `src/shared/` so both the MCP server and dashboard can import them without circular dependencies.

### Architectural Boundaries

```
┌─────────────────────────────────────┐
│  Dashboard (src/dashboard.ts)       │
│  - Reads state files                │
│  - Polls tmux                       │
│  - Renders ANSI                     │
│  - NEVER writes state files         │
│  - NEVER communicates with MCP      │
└──────┬────────┬────────┬────────────┘
       │        │        │
       ▼        ▼        ▼
  ┌────────┐ ┌───────┐ ┌──────────┐
  │shared/ │ │ tmux  │ │ state    │
  │types   │ │panes  │ │ files    │
  │patterns│ │       │ │ (read)   │
  └────────┘ └───────┘ └──────────┘
```

### FR to File Mapping

| FR Category | Primary Files |
|---|---|
| State Reading (FR1-5) | `dashboard/app.ts`, `shared/types.ts` |
| Status Detection (FR6-9) | `dashboard/status.ts`, `shared/tmux.ts`, `shared/status-patterns.ts` |
| Tree Panel (FR10-13) | `dashboard/tree.ts`, `dashboard/render.ts` |
| Message Feed (FR14-18) | `dashboard/feed.ts`, `dashboard/render.ts` |
| Details Panel (FR19-21) | `dashboard/render.ts`, `dashboard/tree.ts` |
| Navigation (FR22-24) | `dashboard/app.ts`, `dashboard/tree.ts`, `dashboard/terminal.ts` |
| Rendering (FR25-29) | `dashboard/render.ts`, `dashboard/terminal.ts` |
| Lifecycle (FR30-32) | `dashboard/app.ts`, `dashboard/terminal.ts` |

## Architecture Validation Results

### Coherence Validation

- Raw ANSI + Bun = no new deps, compatible with existing project
- File-driven updates = no coupling to MCP server
- Shared types/tmux = no code duplication, clean imports
- Module boundaries are acyclic: app → {status, tree, feed, render, terminal}, render → {tree, feed}

### Requirements Coverage

- 32/32 FRs mapped to specific files
- 12/12 NFRs addressed (performance by batch polling, reliability by error handling, compatibility by ANSI standards)
- No gaps

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High — small scope, clear boundaries, all decisions made

**Key Strengths:**
- 6 focused modules with clear single responsibilities
- Zero new dependencies
- Fully decoupled from MCP server
- Shared code prevents duplication

**Implementation Sequence:**
1. Extract shared types/tmux/patterns to `src/shared/`
2. `terminal.ts` — alternate screen, raw mode, resize, cleanup
3. `status.ts` — batch tmux polling (reuses shared tmux wrapper)
4. `tree.ts` — room/agent tree from state data, keyboard nav
5. `feed.ts` — message formatting and buffer
6. `render.ts` — ANSI panel rendering
7. `app.ts` — main loop orchestration
8. `dashboard.ts` — entrypoint
9. Integration testing
