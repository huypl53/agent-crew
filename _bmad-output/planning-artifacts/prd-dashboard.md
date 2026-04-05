---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
classification:
  projectType: developer_tool
  domain: general
  complexity: low
  projectContext: extension
inputDocuments:
  - '_bmad-output/brainstorming/brainstorming-session-2026-04-05-1800.md'
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/session-report.md'
workflowType: 'prd'
status: 'complete'
completedAt: '2026-04-06'
---

# Product Requirements Document - cc-tmux TUI Dashboard

**Author:** lee
**Date:** 2026-04-06
**Classification:** Developer Tool | General Domain | Low Complexity | Extension of cc-tmux

## Executive Summary

The cc-tmux TUI dashboard is a read-only terminal UI that gives the human boss a single-pane control room view of all agent activity. Instead of switching between tmux panes to check on agents, the boss opens one dashboard that shows every room, every agent's status (idle/busy/dead), and a live feed of all messages flowing through the system.

The dashboard is architecturally simple: it reads the same JSON state files the MCP server writes to (`/tmp/cc-tmux/state/`) and polls tmux panes for live status detection. No IPC, no events, no framework. Built with raw ANSI escape codes in Bun — zero additional dependencies.

### What Makes This Special

**Zero overhead.** The dashboard reads files and polls tmux. It doesn't connect to the MCP server, doesn't modify state, and can be started/stopped anytime without affecting agents.

**Same toolchain.** Raw ANSI with Bun means the dashboard shares the same runtime, repo, and type definitions as the MCP server. No React, no blessed, no new dependencies.

**Peripheral awareness.** The boss keeps the dashboard in a tmux pane corner. Agents going red (dead) or yellow (busy→idle) are visible at a glance. The boss stays in their CC session for commands — the dashboard is for observation.

## Success Criteria

### User Success

- Boss can see all rooms, agents, and their statuses in a single terminal pane
- Agent status changes (idle→busy, busy→dead) are visible within 2 seconds
- Message flow across all rooms is visible in a chronological feed
- Dashboard starts instantly and works with any existing cc-tmux setup
- Keyboard navigation lets the boss inspect any agent's details

### Technical Success

- Dashboard renders 3-panel layout correctly on 80x24 minimum terminal
- Batch status polling for 20 agents completes within 500ms
- Full redraw cycle (read files + poll tmux + render) completes within 1 second
- JSON parse errors from partial writes are handled gracefully (retry + last known state)
- Dashboard survives MCP server restarts without crashing

### Measurable Outcomes

- **Time-to-dashboard:** Under 1 second from `bun run src/dashboard.ts` to rendered output
- **Status latency:** Agent status changes visible within 2 seconds (one poll cycle)
- **Stability:** Dashboard runs for 8+ hours without memory leaks or crashes

## Product Scope

### MVP (Phase 1)

**MVP Approach:** Deliver the minimum that makes agent observation work in a single pane. Boss should be able to see all agents, their status, and recent messages.

**Must-Have Capabilities:**

1. **Status polling:** Batch tmux capture-pane for all registered agents every 2 seconds
2. **Room/agent tree:** Collapsible rooms with agents listed by primary room, status inline
3. **Message feed:** Chronological feed of all messages across all rooms, color-coded
4. **Details panel:** Selected agent's full info (role, rooms, status, pane, last activity)
5. **Keyboard navigation:** Arrow keys to select agents in tree, auto-select most recently changed
6. **Alternate screen buffer:** Clean terminal experience (like vim), restore on exit
7. **Terminal resize:** Handle SIGWINCH, recalculate panels, redraw
8. **Error resilience:** Retry on JSON parse error, show last known state on failure

**Absolute minimum viable (if time-constrained):** Status list only — no panels, no tree, no messages. Just a flat list of `agent: status` updating every 2 seconds.

### Growth (Phase 2)

- Room filtering in message feed (toggle to show single room)
- Agent log viewer (capture-pane scrollback for selected agent)
- Configurable panel ratios
- Color theme detection (light/dark terminal)
- Message search/filter

### Vision (Phase 3)

- Boss can send commands from dashboard (interactive mode)
- Dashboard as tmux popup overlay
- Multi-dashboard (one per room)
- Alert sounds/notifications on agent death
- Recording/playback of dashboard sessions

## User Journeys

### Journey 1: Alex Monitors a 5-Agent Team

Alex has boss, lead-1, builder-1, builder-2, tester-1 across 2 rooms. Alex opens a new tmux pane and runs `bun run src/dashboard.ts`.

The 3-panel layout appears: rooms with agents on the left, message feed scrolling on the right, details panel showing the most recently active agent. Alex sees lead-1 is busy (yellow), two workers are idle (green). Messages show lead-1 just assigned tasks to both builders.

Alex keeps the dashboard in a small tmux pane while working in their boss CC session. Peripheral vision catches builder-2 going red — it died. Alex switches to their CC session and tells lead-1 to reassign.

### Journey 2: Server Restart Recovery

The MCP server crashes. Dashboard shows stale data briefly — agents still showing last known status. Alex restarts the server. Agents re-register. Dashboard picks up the new state files on the next poll cycle. Dead agents that didn't re-register show red. Everything recovers in under 5 seconds.

## Developer Tool Specific Requirements

### Language & Runtime

- **Language:** TypeScript
- **Runtime:** Bun (same as MCP server)
- **Platform:** Linux, macOS (anywhere tmux + cc-tmux runs)

### Installation

- Same plugin directory as cc-tmux — no separate install
- `bun run src/dashboard.ts` or `bun run dashboard` (package.json script)

### Project Structure (within cc-tmux)

```
src/
├── dashboard.ts              # Dashboard entrypoint
├── dashboard/
│   ├── app.ts                # Main loop: poll, read, render
│   ├── render.ts             # ANSI rendering: panels, tree, feed
│   ├── tree.ts               # Room/agent tree data structure + nav
│   ├── feed.ts               # Message feed formatting
│   ├── status.ts             # Batch tmux capture-pane + status parse
│   └── terminal.ts           # Raw terminal: alternate screen, resize, cursor, colors
└── ...existing MCP server files...
```

### Shared Code with MCP Server

- Status regex patterns (CC idle/busy/dead detection)
- State file TypeScript interfaces (Agent, Room, Message types)
- tmux wrapper functions (capturePane, isPaneDead)

## Functional Requirements

### State Reading

- FR1: The dashboard can read agent registrations from `/tmp/cc-tmux/state/agents.json`
- FR2: The dashboard can read room definitions from `/tmp/cc-tmux/state/rooms.json`
- FR3: The dashboard can read message queues from `/tmp/cc-tmux/state/messages.json`
- FR4: The dashboard can detect state file changes via `fs.watch`
- FR5: The dashboard can retry once on JSON parse error and fall back to last known state

### Status Detection

- FR6: The dashboard can batch-capture tmux panes for all registered agents every 2 seconds
- FR7: The dashboard can detect agent status (idle/busy/dead/unknown) using CC status line regex
- FR8: The dashboard can detect dead panes via `tmux list-panes -F '#{pane_dead}'`
- FR9: The dashboard can strip ANSI escape codes from capture-pane output

### Tree Panel

- FR10: The dashboard can display rooms as collapsible groups with member counts
- FR11: The dashboard can display agents under their primary room with inline status
- FR12: The dashboard can show multi-room agents with a badge (e.g., `lead-1 [+company]`) without duplication
- FR13: The dashboard can color-code agent status: green=idle, yellow=busy, red=dead, gray=unknown

### Message Feed Panel

- FR14: The dashboard can display messages from all rooms in chronological order
- FR15: The dashboard can format messages as `HH:MM:SS [sender@room] → target: text`
- FR16: The dashboard can color-code room names in the feed for differentiation
- FR17: The dashboard can show broadcast messages with `→ ALL` target
- FR18: The dashboard can auto-scroll to show newest messages at bottom

### Details Panel

- FR19: The dashboard can show selected agent's full info (name, role, rooms, status, pane, last activity)
- FR20: The dashboard can auto-select the most recently changed agent by default
- FR21: The dashboard can update selection via arrow key navigation in the tree

### Navigation & Interaction

- FR22: The dashboard can accept up/down arrow keys to navigate the agent tree
- FR23: The dashboard can highlight the currently selected agent in the tree
- FR24: The dashboard can quit cleanly on `q` or `Ctrl+C`, restoring the terminal

### Rendering

- FR25: The dashboard can render a 3-panel layout using raw ANSI escape codes
- FR26: The dashboard can use the alternate screen buffer for clean entry/exit
- FR27: The dashboard can perform full redraws every poll cycle without visible flicker
- FR28: The dashboard can handle terminal resize (SIGWINCH) by recalculating panel dimensions
- FR29: The dashboard can render box-drawing characters for panel borders

### Lifecycle

- FR30: The dashboard can start without the MCP server running (shows empty state)
- FR31: The dashboard can survive MCP server restarts without crashing
- FR32: The dashboard can detect when state directory doesn't exist and show a waiting message

## Non-Functional Requirements

### Performance

- NFR1: Full render cycle (read files + poll tmux + draw) must complete within 1 second
- NFR2: Batch status polling for 20 agents must complete within 500ms
- NFR3: Dashboard must start and display first frame within 1 second
- NFR4: Memory usage must remain stable over 8+ hours of continuous operation

### Reliability

- NFR5: JSON parse errors must not crash the dashboard
- NFR6: Dead tmux panes must not cause unhandled exceptions
- NFR7: Terminal must be restored to normal state on any exit (clean, crash, signal)
- NFR8: Dashboard must not modify any state files (strictly read-only)

### Compatibility

- NFR9: Must render correctly on terminals 80 columns x 24 rows minimum
- NFR10: Must support tmux 3.0 and later
- NFR11: Must run on Linux and macOS
- NFR12: Must work with any terminal that supports ANSI escape codes and 256 colors

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Raw ANSI rendering complexity | Build bottom-up: status list first, then panels. Validate rendering on multiple terminal emulators. |
| Flickering on full redraws | Alternate screen buffer + write to string buffer then flush once. Double-buffering if needed. |
| Race condition on file reads | Atomic writes (temp+rename) in MCP server, retry on parse error in dashboard. |
| Terminal not restored on crash | Register handlers for SIGINT, SIGTERM, uncaughtException to restore terminal state. |
| Large message feeds consuming memory | Cap message buffer at 500 messages, discard oldest. |

## Open Questions for Implementation

1. **Panel width ratios** — Fixed 30/70 split or configurable? Start with fixed.
2. **Message buffer size** — Last 500 messages in memory? Configurable?
3. **Tree collapse persistence** — Remember collapsed rooms across redraws? Probably yes.
4. **Color theme** — Hardcoded dark theme for v1. Light theme detection in Phase 2.
5. **Quit key** — `q` to quit, `Ctrl+C` as fallback. Both restore terminal.
