---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
inputDocuments:
  - '_bmad-output/planning-artifacts/prd-dashboard.md'
  - '_bmad-output/planning-artifacts/architecture-dashboard.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-04-05-1800.md'
status: 'complete'
completedAt: '2026-04-06'
---

# cc-tmux TUI Dashboard - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the cc-tmux TUI dashboard. Scope: MVP read-only observer with 3-panel layout, raw ANSI rendering, batch status polling, and keyboard navigation. 32 FRs, 12 NFRs.

## Requirements Inventory

### Functional Requirements

FR1: The dashboard can read agent registrations from `/tmp/cc-tmux/state/agents.json`
FR2: The dashboard can read room definitions from `/tmp/cc-tmux/state/rooms.json`
FR3: The dashboard can read message queues from `/tmp/cc-tmux/state/messages.json`
FR4: The dashboard can detect state file changes via `fs.watch`
FR5: The dashboard can retry once on JSON parse error and fall back to last known state
FR6: The dashboard can batch-capture tmux panes for all registered agents every 2 seconds
FR7: The dashboard can detect agent status (idle/busy/dead/unknown) using CC status line regex
FR8: The dashboard can detect dead panes via `tmux list-panes -F '#{pane_dead}'`
FR9: The dashboard can strip ANSI escape codes from capture-pane output
FR10: The dashboard can display rooms as collapsible groups with member counts
FR11: The dashboard can display agents under their primary room with inline status
FR12: The dashboard can show multi-room agents with a badge without duplication
FR13: The dashboard can color-code agent status: green=idle, yellow=busy, red=dead, gray=unknown
FR14: The dashboard can display messages from all rooms in chronological order
FR15: The dashboard can format messages as `HH:MM:SS [sender@room] → target: text`
FR16: The dashboard can color-code room names in the feed for differentiation
FR17: The dashboard can show broadcast messages with `→ ALL` target
FR18: The dashboard can auto-scroll to show newest messages at bottom
FR19: The dashboard can show selected agent's full info
FR20: The dashboard can auto-select the most recently changed agent by default
FR21: The dashboard can update selection via arrow key navigation in the tree
FR22: The dashboard can accept up/down arrow keys to navigate the agent tree
FR23: The dashboard can highlight the currently selected agent in the tree
FR24: The dashboard can quit cleanly on `q` or `Ctrl+C`, restoring the terminal
FR25: The dashboard can render a 3-panel layout using raw ANSI escape codes
FR26: The dashboard can use the alternate screen buffer for clean entry/exit
FR27: The dashboard can perform full redraws every poll cycle without visible flicker
FR28: The dashboard can handle terminal resize (SIGWINCH) by recalculating panel dimensions
FR29: The dashboard can render box-drawing characters for panel borders
FR30: The dashboard can start without the MCP server running (shows empty state)
FR31: The dashboard can survive MCP server restarts without crashing
FR32: The dashboard can detect when state directory doesn't exist and show a waiting message

### Non-Functional Requirements

NFR1: Full render cycle must complete within 1 second
NFR2: Batch status polling for 20 agents must complete within 500ms
NFR3: Dashboard must start and display first frame within 1 second
NFR4: Memory usage must remain stable over 8+ hours
NFR5: JSON parse errors must not crash the dashboard
NFR6: Dead tmux panes must not cause unhandled exceptions
NFR7: Terminal must be restored to normal state on any exit
NFR8: Dashboard must not modify any state files (read-only)
NFR9: Must render correctly on 80x24 minimum terminal
NFR10: Must support tmux 3.0+
NFR11: Must run on Linux and macOS
NFR12: Must work with any terminal supporting ANSI 256 colors

### Additional Requirements

- Extract shared types, tmux wrapper, and status patterns to `src/shared/` for MCP + dashboard reuse
- Dashboard is a separate entrypoint (`src/dashboard.ts`) in the same repo
- Package.json script: `"dashboard": "bun run src/dashboard.ts"`

### FR Coverage Map

| FR | Epic | Description |
|---|---|---|
| FR1-3 | Epic 1 | Read state JSON files |
| FR4-5 | Epic 1 | File watching + error resilience |
| FR6-9 | Epic 2 | Batch tmux status polling |
| FR10-13 | Epic 3 | Room/agent tree panel |
| FR14-18 | Epic 4 | Message feed panel |
| FR19-21 | Epic 4 | Details panel |
| FR22-24 | Epic 3 | Keyboard navigation + quit |
| FR25-29 | Epic 3 | ANSI panel rendering |
| FR30-32 | Epic 1 | Lifecycle resilience |

## Epic List

### Epic 1: Terminal Foundation & State Reading
The dashboard can start, enter alternate screen, read cc-tmux state files, and display a basic agent status list.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR26, FR27, FR30, FR31, FR32
**NFRs addressed:** NFR3, NFR5, NFR7, NFR8

### Epic 2: Live Status Detection
The dashboard can poll tmux panes in batch and show real-time idle/busy/dead status for all agents.
**FRs covered:** FR6, FR7, FR8, FR9, FR13
**NFRs addressed:** NFR1, NFR2, NFR6

### Epic 3: 3-Panel Layout & Navigation
The dashboard renders the full 3-panel layout with room/agent tree, keyboard navigation, and panel borders.
**FRs covered:** FR10, FR11, FR12, FR22, FR23, FR24, FR25, FR28, FR29
**NFRs addressed:** NFR4, NFR9

### Epic 4: Message Feed & Details
The dashboard shows a live message feed and agent details panel, completing the full observation experience.
**FRs covered:** FR14, FR15, FR16, FR17, FR18, FR19, FR20, FR21
**NFRs addressed:** NFR1

### Epic 5: Integration Testing
End-to-end tests validate the dashboard works with real state files and tmux panes.
**FRs validated:** All FRs

---

## Epic 0: Shared Code Extraction

Refactor existing MCP server code to extract shared modules for dashboard reuse.

### Story 0.1: Extract Shared Types, tmux Wrapper, and Status Patterns

As a developer,
I want shared types, tmux functions, and CC status regex patterns in `src/shared/`,
So that both the MCP server and dashboard can import them without duplication.

**Acceptance Criteria:**

**Given** existing code in `src/tmux/index.ts` and `src/state/index.ts`
**When** shared code is extracted
**Then** `src/shared/types.ts` exports `Agent`, `Room`, `Message`, `Status` interfaces
**And** `src/shared/tmux.ts` exports `capturePane()`, `isPaneDead()`, `validateTmux()`, `sendKeys()`
**And** `src/shared/status-patterns.ts` exports CC idle/busy/dead regex patterns
**And** `src/tmux/index.ts` and `src/state/index.ts` import from `src/shared/` instead of defining locally
**And** all existing MCP server tests still pass
**And** no functionality changes — pure refactor

---

## Epic 1: Terminal Foundation & State Reading

The dashboard can start, enter alternate screen, read cc-tmux state files, and display a basic agent status list.

### Story 1.1: Terminal Management Module

As a developer,
I want a terminal module that manages alternate screen, raw mode, and cleanup,
So that the dashboard has a clean terminal experience like vim.

**Acceptance Criteria:**

**Given** the dashboard starts
**When** `terminal.ts` initializes
**Then** it enters alternate screen buffer via `\x1b[?1049h` (FR26)
**And** it sets stdin to raw mode for keyboard input
**And** it registers cleanup handlers for SIGINT, SIGTERM, SIGHUP, uncaughtException (NFR7)
**And** on any exit, it restores the alternate screen and raw mode
**And** it handles SIGWINCH by emitting a resize event with new terminal dimensions (FR28)
**And** it provides `write(buffer: string)` to flush a complete frame to stdout

### Story 1.2: State File Reader

As a developer,
I want a state reader that loads and watches cc-tmux JSON files,
So that the dashboard always has current agent, room, and message data.

**Acceptance Criteria:**

**Given** state files exist in `/tmp/cc-tmux/state/`
**When** the reader initializes
**Then** it reads and parses `agents.json`, `rooms.json`, `messages.json` (FR1, FR2, FR3)
**And** it sets up `fs.watch()` on the state directory for change notifications (FR4)
**And** on file change, it re-reads the changed file
**And** on JSON parse error, it retries once, then falls back to last known state (FR5, NFR5)
**And** it never writes to state files (NFR8)

**Given** the state directory doesn't exist
**When** the reader initializes
**Then** it returns empty state and the dashboard shows "Waiting for cc-tmux..." (FR32)

**Given** the MCP server restarts
**When** state files are rewritten
**Then** the reader picks up new state on the next fs.watch notification (FR31)

### Story 1.3: Basic Status List Display

As a boss,
I want to see a simple list of all agents with their rooms when the dashboard starts,
So that I can verify the dashboard is working and see who's registered.

**Acceptance Criteria:**

**Given** agents and rooms are loaded from state files
**When** the dashboard renders
**Then** it shows a list of all agents grouped by room with their role
**And** it redraws every 2 seconds or on file change (FR27)
**And** it starts without the MCP server running (shows empty state) (FR30)
**And** startup to first frame is under 1 second (NFR3)

---

## Epic 2: Live Status Detection

The dashboard can poll tmux panes in batch and show real-time idle/busy/dead status for all agents.

### Story 2.1: Batch tmux Status Polling

As a developer,
I want a status module that batch-captures all agent panes every 2 seconds,
So that the dashboard shows live idle/busy/dead status for every agent.

**Acceptance Criteria:**

**Given** agents are loaded from state files with tmux_target info
**When** a poll cycle runs
**Then** it checks each agent's pane liveness via `isPaneDead()` (FR8)
**And** for live panes, it captures output via `capturePane()` and strips ANSI (FR9)
**And** it matches CC status line regex to determine idle/busy/unknown (FR7)
**And** dead panes return status `dead`, failed captures return `unknown`
**And** the entire batch for 20 agents completes within 500ms (NFR2)
**And** dead pane errors don't cause unhandled exceptions (NFR6)

### Story 2.2: Color-Coded Status in Display

As a boss,
I want to see agent status as color-coded indicators that update in real-time,
So that I can spot problems (red=dead) at a glance.

**Acceptance Criteria:**

**Given** batch status polling is running
**When** the dashboard renders agent status
**Then** idle agents show green `●` (FR13)
**And** busy agents show yellow `●`
**And** dead agents show red `●`
**And** unknown agents show gray `●`
**And** status updates are visible within 2 seconds of the actual state change
**And** the full render cycle (read + poll + draw) completes within 1 second (NFR1)

---

## Epic 3: 3-Panel Layout & Navigation

The dashboard renders the full 3-panel layout with room/agent tree, keyboard navigation, and panel borders.

### Story 3.1: Panel Layout Renderer

As a developer,
I want a render module that draws a 3-panel layout with box borders,
So that the dashboard has a structured, readable display.

**Acceptance Criteria:**

**Given** terminal dimensions are known
**When** the renderer draws a frame
**Then** it draws a left panel (30% width, full height) with box borders (FR25, FR29)
**And** a right-top panel (70% width, 65% height) with box borders
**And** a right-bottom panel (70% width, 35% height) with box borders
**And** panels have title labels in the top border
**And** the layout renders correctly on 80x24 minimum terminal (NFR9)
**And** on terminal resize, panel dimensions recalculate and redraw (FR28)

### Story 3.2: Room/Agent Tree

As a boss,
I want to see rooms as collapsible groups with agents listed under their primary room,
So that I can understand the organizational structure at a glance.

**Acceptance Criteria:**

**Given** agents are registered in rooms
**When** the tree renders in the left panel
**Then** rooms are displayed as collapsible groups with member count: `▼ frontend (3)` (FR10)
**And** agents appear under their primary room (first room joined) with inline status (FR11)
**And** multi-room agents show a badge: `lead-1 [+company]` without duplication (FR12)
**And** the currently selected agent is highlighted with inverse colors (FR23)

### Story 3.3: Keyboard Navigation

As a boss,
I want to navigate the agent tree with arrow keys and quit with `q`,
So that I can inspect any agent and exit cleanly.

**Acceptance Criteria:**

**Given** the dashboard is running with agents displayed
**When** the user presses up/down arrow keys
**Then** the selection moves through the flattened tree (rooms + agents) (FR22)
**And** the details panel updates to show the selected agent's info (FR21)

**Given** a new agent status change occurs
**When** no manual selection has been made
**Then** the most recently changed agent is auto-selected (FR20)

**Given** the user presses `q` or `Ctrl+C`
**When** the quit handler fires
**Then** the terminal is restored and the process exits cleanly (FR24, NFR7)

---

## Epic 4: Message Feed & Details

The dashboard shows a live message feed and agent details panel, completing the full observation experience.

### Story 4.1: Message Feed Panel

As a boss,
I want to see a live chronological feed of all messages across all rooms,
So that I can follow the communication flow between agents.

**Acceptance Criteria:**

**Given** messages exist in `messages.json`
**When** the feed panel renders
**Then** messages are displayed chronologically with newest at bottom (FR14)
**And** format is `HH:MM:SS [sender@room] → target: text` (FR15)
**And** room names are color-coded for differentiation (FR16)
**And** broadcast messages show `→ ALL` (FR17)
**And** the feed auto-scrolls to show the latest messages (FR18)
**And** the message buffer caps at 500 messages (oldest discarded)
**And** memory remains stable over 8+ hours of operation (NFR4)

### Story 4.2: Agent Details Panel

As a boss,
I want to see the selected agent's full details in the bottom-right panel,
So that I can inspect their role, rooms, status, and pane info.

**Acceptance Criteria:**

**Given** an agent is selected (via keyboard or auto-select)
**When** the details panel renders
**Then** it shows: name, role, all rooms, current status, tmux pane ID, last activity timestamp (FR19)
**And** when auto-select is active, it shows the most recently changed agent (FR20)
**And** when manual selection overrides, it shows the manually selected agent (FR21)

---

## Epic 5: Integration Testing

End-to-end tests validate the dashboard works with real state files and tmux panes.

### Story 5.1: Dashboard Integration Tests

As a developer,
I want integration tests that validate the dashboard reads state and renders correctly,
So that I have confidence in the full render pipeline.

**Acceptance Criteria:**

**Given** the test infrastructure from the MCP server tests is available
**When** dashboard integration tests run
**Then** tests validate:

**State Reading:**
- Dashboard reads agents.json and renders agent list
- Dashboard detects file changes via fs.watch and updates display
- Dashboard retries on corrupted JSON and uses last known state
- Dashboard shows "Waiting for cc-tmux..." when state dir doesn't exist

**Status Detection:**
- Dashboard detects idle/busy/dead status from tmux panes
- Dashboard handles dead pane gracefully (shows red, no crash)
- Batch polling completes within 500ms for 10 test agents

**Rendering:**
- Panel layout produces valid ANSI output
- Tree correctly groups agents by primary room
- Multi-room agents show badge, no duplication
- Color codes match status (green/yellow/red/gray)

**Lifecycle:**
- Dashboard starts and displays first frame within 1 second
- Dashboard survives state file deletion and recreation
- Terminal is restored on quit (q and Ctrl+C)

**And** all tests clean up tmux sessions and temp files
