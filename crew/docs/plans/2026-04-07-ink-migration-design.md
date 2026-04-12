# Dashboard Ink Migration Design

**Date**: 2026-04-07
**Status**: Approved
**Scope**: Full rewrite of `src/dashboard/` from raw ANSI to React+Ink components

## Problem Statement

The current dashboard is a 952-line raw ANSI renderer. Every layout change requires manual coordinate math (`moveTo(row, col)`), manual ANSI escape sequences, and manual truncation. We just fixed 7 bugs in this system. Adding features like scrolling, resizable panels, or new data views requires disproportionate effort.

Additionally, two user-requested features need implementation:
1. **Role in tree** — Show agent role alongside name (e.g., `● lead-1 (leader)`)
2. **Task summary** — Extract task/completion/error counts from message kinds

## Decision: Migrate to Ink

**Ink** is a React renderer for terminal UIs (used by Claude Code itself). It provides:
- Flexbox layout via Yoga (no manual coordinate math)
- React component model (composable, testable)
- Built-in `useInput` hook for keyboard handling
- `Box` and `Text` primitives with border, color, padding props
- Ecosystem: `@inkjs/ui` (SelectInput, Spinner, TextInput)

**What Ink does NOT provide** (must build custom):
- Tree/treeview component (no `ink-tree` on npm)
- Scroll area (no `ink-scroll-area` on npm)
- Multi-panel fixed layout (use `Box` with percentage widths)

## Architecture

### Component Tree

```
<App>
  <Layout>                          // Full-screen flexbox container
    <TreePanel />                   // Left 30% — rooms & agents
    <RightColumn>                   // Right 70%
      <MessageFeed />               // Top 65% — chronological messages
      <DetailsPanel />              // Bottom 35% — agent/room details
    </RightColumn>
  </Layout>
  <StatusBar />                     // Bottom row — shortcuts + error flag
  {showHelp && <HelpOverlay />}     // Centered modal
</App>
```

### Module Mapping (old → new)

| Old File | New File(s) | What Changes |
|----------|-------------|-------------|
| `terminal.ts` | Deleted | Ink handles raw mode, alt screen, cleanup |
| `render.ts` (258 lines) | Deleted | Replaced by component tree |
| `tree.ts` | `hooks/useTree.ts` | TreeState logic becomes a React hook |
| `feed.ts` | `hooks/useFeed.ts` | MessageFeed logic becomes a React hook |
| `status.ts` | `hooks/useStatus.ts` | StatusPoller becomes a React hook |
| `state-reader.ts` | `hooks/useStateReader.ts` | StateReader becomes a React hook |
| `logger.ts` | `logger.ts` (keep) | No change — file-based logging |
| `app.ts` | `App.tsx` | React component with hooks |
| — | `components/TreePanel.tsx` | New: room/agent tree with role display |
| — | `components/MessageFeed.tsx` | New: scrollable message list |
| — | `components/DetailsPanel.tsx` | New: agent details + pane output |
| — | `components/StatusBar.tsx` | New: shortcut bar |
| — | `components/HelpOverlay.tsx` | New: help modal |
| — | `components/Layout.tsx` | New: 3-panel flexbox shell |

### Data Flow

```
SQLite DB (polled every 500ms by useStateReader)
  → DashboardState { agents, rooms, messages }
    → useTree(state, statuses) → TreeNode[] + selection
    → useFeed(state.messages) → FormattedMessage[]
    → useStatus(state.agents) → Map<string, AgentStatusEntry>
      → Components render from hook state
      → useInput handles keyboard → updates hook state → React re-renders
```

**Key principle:** Hooks own state and logic. Components are pure renderers. No business logic in components.

### What Stays the Same

- `logger.ts` — unchanged (file-based error logging)
- `../shared/types.ts` — unchanged (Agent, Room, Message types)
- `../shared/status-patterns.ts` — unchanged (regex matching)
- `../tmux/index.ts` — unchanged (capturePane, isPaneDead)
- Data flow: SQLite → StateReader → StatusPoller → render
- Keyboard shortcuts: j/k, gg/G, Enter, ?, q

### What Changes

- No more manual `moveTo(row, col)` coordinate math
- No more manual ANSI escape code construction
- No more manual `truncate()` / `visibleLength()` — Ink handles text overflow
- No more manual box drawing (`drawBox`) — Ink `Box` has `borderStyle`
- Layout adapts to terminal resize automatically (Ink handles `SIGWINCH`)

## Component Designs

### TreePanel

```tsx
<Box flexDirection="column" width="30%" borderStyle="single">
  <Text bold> Rooms & Agents </Text>
  {visibleNodes.map(node => (
    node.type === 'room'
      ? <RoomRow key={node.id} node={node} selected={isSelected} />
      : <AgentRow key={node.id} node={node} selected={isSelected} />
  ))}
</Box>
```

**AgentRow rendering (NEW — role in tree):**
```
● lead-1 (leader)     ← primary appearance
◦ lead-1 (leader)     ← secondary (dim)
```

Role is appended in dim after agent name. Status dot color unchanged.

### MessageFeed

```tsx
<Box flexDirection="column" borderStyle="single" height="65%">
  <Text bold> Messages {roomFilter ? `[${roomFilter}]` : ''} </Text>
  {visibleMessages.map(msg => (
    <MessageRow key={msg.id} msg={msg} />
  ))}
</Box>
```

Each message row: `HH:MM:SS [BADGE] [sender@room] → target: text`

Badges colored by kind: `[DONE]` green, `[ERR]` red, `[?]` yellow, `[TASK]` cyan.

### DetailsPanel

Shows different content based on selection:

**Agent selected:**
```
boss-1                          ← bold name
busy  boss · %101               ← status + role + pane
Rooms: company, frontend
Topic: Build login flow
Last: 3m ago

─ pane ─
· Working on auth.ts...         ← live capture-pane tail
```

**Room selected:**
```
frontend
Topic: Build login flow
Members: 3

─ Task Summary ─                ← NEW feature
Tasks sent: 5
Completed: 3  Errors: 1  Open: 1
```

**Task summary** is derived from message kinds in the selected room:
- Count messages with `kind: 'task'` → tasks sent
- Count messages with `kind: 'completion'` → completed
- Count messages with `kind: 'error'` → errors
- Open = tasks - completed - errors

### StatusBar

```tsx
<Box height={1}>
  <Text dimColor>↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit</Text>
  {hasErrors && <Text color="red"> [!]</Text>}
</Box>
```

### HelpOverlay

Centered box with key bindings, rendered conditionally over the layout.

## New Features

### 1. Role in Tree (Enhancement)

TreeNode already has `role` field. AgentRow renders it:
```
● agent-name (role)
```

Implementation: ~3 lines in AgentRow component. No data model changes.

### 2. Task Summary from Message Kinds (Enhancement)

When a **room** is selected, the DetailsPanel queries message kinds for that room:

```typescript
function useTaskSummary(messages: Message[], room: string) {
  const roomMsgs = messages.filter(m => m.room === room);
  return {
    tasks: roomMsgs.filter(m => m.kind === 'task').length,
    completed: roomMsgs.filter(m => m.kind === 'completion').length,
    errors: roomMsgs.filter(m => m.kind === 'error').length,
    questions: roomMsgs.filter(m => m.kind === 'question').length,
  };
}
```

Implementation: Custom hook + 5 lines in DetailsPanel. No schema changes.

## Dependencies

```json
{
  "ink": "^6.8.0",
  "react": "^19.2.4",
  "@inkjs/ui": "^2.0.0",
  "ink-testing-library": "^4.x"
}
```

**Bun compatibility verified:** Ink 6.8.0 renders correctly with Bun 1.3.8. Layout, borders, colors, nested Box components all work. `useInput` requires a TTY (same as our current raw mode setup — not a problem since the dashboard always runs in a terminal).

No other dependencies needed. `ink-text-input`, `ink-table` etc. are not required for our use case.

## Testing Strategy

- **Unit tests**: Hook logic (useTree, useFeed, useStatus) tested independently — same assertions as current tests
- **Component tests**: Use `ink-testing-library` to render components and assert text output
- **Integration**: `renderFrame()` equivalent becomes rendering `<App>` with mock state and asserting output contains expected strings

Current test coverage (19 tests in dashboard.test.ts) maps to:
- Tree tests → useTree hook tests (same logic, different wrapper)
- Feed tests → useFeed hook tests (same logic)
- Render tests → component snapshot tests via `ink-testing-library`

## Migration Strategy

**Incremental, not big-bang:**

1. Add Ink dependencies (`bun add ink react @inkjs/ui ink-testing-library`)
2. Create hooks from existing classes (useTree wraps TreeState, etc.)
3. Build components one at a time, test each
4. Wire up App.tsx with all hooks + components
5. Update entry point (`src/dashboard/main.ts`) to use Ink's `render()`
6. Delete old files (terminal.ts, render.ts)
7. Update tests to use ink-testing-library
8. Update architecture docs

## Prior Art

Real-world Ink monitoring dashboards confirm this approach:

- **cc-guard** (Claude Code cost monitoring) — multi-panel layout, 1s polling, responsive breakpoints, `useMemo` for derived state
- **joy** (Claude session monitoring) — list-focused, event-driven updates, uses `ink-scroll-view`
- **vigil** (PR lifecycle management) — Zustand for shared state, multi-view architecture

All use `useState` + custom hooks for state. Only `vigil` uses Zustand (for its larger scope). Our dashboard is closer to cc-guard/joy — custom hooks are sufficient.

## Risks

| Risk | Mitigation |
|------|-----------|
| Ink + Bun compatibility | **Verified** — Ink 6.8.0 renders correctly with Bun 1.3.8 (smoke test passed) |
| No scroll component | Build custom virtual scroll (same logic as current tree.ts `startIdx`/`treeMaxLines`) |
| Performance (2s poll) | **Validated** — cc-guard polls at 1s successfully; Ink supports incremental rendering |
| React overhead in terminal | Minimal — Ink's Yoga renderer is lightweight, no DOM |
| `useInput` in non-TTY | Only affects testing — use `ink-testing-library` which mocks stdin |
