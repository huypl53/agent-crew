# Dashboard Worker Revocation + Actor/Task Control — Design Spec

**Goal:** Add interactive controls to the dashboard TUI so the human operator can revoke agents, interrupt/clear workers, and manage tasks directly — without needing to go through an agent.

**Approach:** Dashboard calls state layer functions (`src/state/index.ts`) and tmux functions (`src/tmux/index.ts`) directly. No subprocess spawning. No role checks — the human operator is the ultimate authority.

---

## Agent Actions (Tree Panel — dashboard view)

When an agent node is selected in the tree panel:

| Key | Action | Confirmation | Implementation |
|-----|--------|-------------|----------------|
| `x` | **Revoke agent** — interrupt active task, remove from all rooms, mark dead | Yes (y/n) | `sendEscape(pane)` → `cleanupDeadAgentTasks(name)` → `removeAgentFully(name)` |
| `i` | **Interrupt task** — send Escape to worker's pane | Yes (y/n) | `sendEscape(pane)` + `updateTaskStatus(taskId, 'interrupted', null, null, 'dashboard')` |
| `c` | **Clear session** — send /clear to worker's pane | Yes (y/n) | `sendKeys(pane, '/clear')` then after 2s `sendKeys(pane, '/crew:refresh --name <name>')` |

**Preconditions:**
- `x` — agent must exist (any status)
- `i` — agent must have an active task; no-op with status message if idle
- `c` — agent pane must be alive; error if dead

## Task Actions (Task Board — tasks view)

When a task is selected in the task board:

| Key | Action | Confirmation | Implementation |
|-----|--------|-------------|----------------|
| `i` | **Interrupt task** — send Escape, mark interrupted | Yes if active | `sendEscape(assignee pane)` + `updateTaskStatus(id, 'interrupted', null, null, 'dashboard')` |
| `d` | **Cancel/delete task** — remove from queue | Yes | `updateTaskStatus(id, 'cancelled', 'Cancelled by operator', null, 'dashboard')` |
| `r` | **Reassign task** — inline text input for new instructions | No (typing is intentional) | Interrupt old → create new task → `sendKeys(assignee pane, newText)` |

**State machine constraints:**
- `i` (interrupt): only valid for `active` tasks
- `d` (cancel): only valid for `queued` or `sent` tasks
- `r` (reassign): valid for `active` or `queued` tasks

## UI Components

### ConfirmPrompt
Renders inline at the bottom of the screen, replacing the status bar temporarily:
```
Revoke wk-01? (y/n)
```
- Blocks all other keyboard input until answered
- `y` executes action, `n` cancels
- Escape also cancels

### StatusFeedback
Shows action result in the status bar area:
- Green text for success: `"Interrupted wk-01 (task #42)"`
- Red text for error: `"Error: agent pane is dead"`
- Auto-dismisses after 3 seconds

### InlineTextInput (for reassign)
Shows at the bottom when `r` is pressed on a task:
```
Reassign task #42 to wk-01: [new instructions here...]
```
- Enter submits, Escape cancels
- Uses Ink's `<TextInput>` component

## Shared Hook: useActions

Manages action state, confirmation flow, and status feedback:

```typescript
interface UseActionsReturn {
  // Confirmation
  pendingAction: PendingAction | null;
  confirm: () => void;
  cancel: () => void;
  requestAction: (action: PendingAction) => void;

  // Status feedback
  feedback: { text: string; type: 'success' | 'error' } | null;
  showFeedback: (text: string, type: 'success' | 'error') => void;

  // Text input
  textInput: { prompt: string; onSubmit: (text: string) => void } | null;
  requestTextInput: (prompt: string, onSubmit: (text: string) => void) => void;
  cancelTextInput: () => void;
}
```

## Keyboard Routing

The `useInput` in App.tsx needs view-aware routing:
- Dashboard view: agent actions (x/i/c) operate on selected tree node
- Tasks view: task actions (i/d/r) operate on selected task
- When confirm prompt is active: only y/n/Escape are handled
- When text input is active: all input goes to TextInput

## Files to Create/Modify

**Create:**
- `src/dashboard/hooks/useActions.ts` — action state management
- `src/dashboard/components/ConfirmPrompt.tsx` — confirmation UI
- `src/dashboard/components/StatusFeedback.tsx` — result feedback UI
- `src/dashboard/components/InlineTextInput.tsx` — text input for reassign

**Modify:**
- `src/dashboard/App.tsx` — add useActions hook, wire keyboard routing, render confirm/feedback
- `src/dashboard/components/StatusBar.tsx` — integrate feedback display
- `src/dashboard/components/TaskBoard.tsx` — add task action hotkeys, expose selected task
- `src/dashboard/components/HelpOverlay.tsx` — document new hotkeys
