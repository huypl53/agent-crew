# Hook Fixture Tests

Data-driven test harness for `processHookEventInput()` — the central hook handler that processes Claude Code lifecycle events (Stop, UserPromptSubmit, PermissionRequest) for crew agents.

Adding a new edge case = adding a `.fixture.json` file. No code changes needed.

## Running

```bash
# all fixtures + unit tests
bun test test/hook-fixture.test.ts

# all tool-command tests (goal, hint, batch-send)
bun test test/tool-commands.test.ts

# both
bun test test/hook-fixture.test.ts test/tool-commands.test.ts
```

## Fixture format

Each `.fixture.json` has three sections: **seed** (initial DB state), **steps** (events to fire), and **expect** (assertions per step).

### Minimal example

```json
{
  "name": "stop-basic",
  "description": "Basic Stop event returns ok with allow decision",
  "seed": {
    "room": { "name": "dev", "path": "/tmp/test-crew" },
    "agents": [
      { "name": "w1", "pane": "%42", "role": "worker" }
    ]
  },
  "steps": [
    {
      "event": "Stop",
      "pane": "%42",
      "expect": {
        "stdout": { "ok": true, "decision": "allow" }
      }
    }
  ]
}
```

### Seed

| Field | Type | Description |
|-------|------|-------------|
| `room` | `{name, path}` | Room to create |
| `agents` | `Array<{name, pane, role}>` | Agents to register. `role` is `"leader"` or `"worker"` |
| `hints` | `Array<{agent, message, cadence?}>` | Optional. Pre-set hints (default cadence: 3) |
| `goals` | `Array<{agent, description}>` | Optional. Pre-set goals |

### Steps

Each step fires one hook event and optionally asserts on the response and tmux side effects.

| Field | Type | Description |
|-------|------|-------------|
| `event` | `string` | Hook event name: `"Stop"`, `"UserPromptSubmit"`, `"PermissionRequest"`, or `"__skip__"` (uses payload field instead) |
| `pane` | `string` | Tmux pane ID (defaults to first agent's pane) |
| `payload` | `object` | Extra fields merged into the hook input JSON |
| `delay` | `number` | Milliseconds to wait before firing (for timing tests) |
| `expect` | `object` | Assertions (see below) |

### Assertions

All assertion types are optional per step.

#### `stdout` — check hook JSON response fields

```json
"stdout": { "ok": true, "decision": "allow" }
```

Each key/value is compared with deep equality (null == undefined).

#### `stdout_path` — check nested response fields by dot-path

```json
"stdout_path": [
  { "path": "hint.message", "value": "Remember: use TypeScript" }
]
```

#### `tmux` — assert tmux calls happened (within this step)

```json
"tmux": [
  { "op": "sendKeys", "target": "%42", "contains": "Goal" }
]
```

| Field | Description |
|-------|-------------|
| `op` | `"sendKeys"` or `"sendCommand"` |
| `target` | Expected pane ID |
| `contains` | Substring match on the sent text |
| `matches` | Regex match on the sent text |

#### `tmux_absent` — assert tmux calls did NOT happen

```json
"tmux_absent": [
  { "op": "sendKeys", "target": "%11" }
]
```

Same fields as `tmux`. Fails if any matching entry is found.

## Common patterns

### Goal reminder on Stop

Worker gets a goal reminder via `sendKeys` on every Stop event:

```json
{
  "seed": {
    "goals": [{ "agent": "w1", "description": "Build auth" }]
  },
  "steps": [{
    "event": "Stop",
    "pane": "%42",
    "expect": {
      "tmux": [{ "op": "sendKeys", "target": "%42", "contains": "Build auth" }]
    }
  }]
}
```

### Leader goal reminder (armed only)

Leaders only get reminders after `armLeaderGoalReminder` is called (done by delivery system). To test this, use the `stop-leader-no-armed-goal` pattern — a leader with a goal but no armed reminder should NOT get sendKeys.

### Hint cadence

Hints fire every Nth `UserPromptSubmit`. Fire N steps, assert hint appears only on the Nth:

```json
{
  "seed": {
    "hints": [{ "agent": "w1", "message": "Stay focused", "cadence": 2 }]
  },
  "steps": [
    { "event": "UserPromptSubmit", "pane": "%42", "expect": { "stdout_path": [{ "path": "hint", "value": null }] } },
    { "event": "UserPromptSubmit", "pane": "%42", "expect": { "stdout_path": [{ "path": "hint.message", "value": "Stay focused" }] } }
  ]
}
```

### Multi-agent isolation

Use multiple agents with different panes. Assert that events on one agent's pane don't affect another:

```json
{
  "seed": {
    "agents": [
      { "name": "w1", "pane": "%11", "role": "worker" },
      { "name": "w2", "pane": "%12", "role": "worker" }
    ],
    "goals": [
      { "agent": "w1", "description": "Goal A" },
      { "agent": "w2", "description": "Goal B" }
    ]
  },
  "steps": [
    {
      "event": "Stop",
      "pane": "%11",
      "expect": {
        "tmux": [{ "op": "sendKeys", "target": "%11", "contains": "Goal A" }],
        "tmux_absent": [{ "op": "sendKeys", "target": "%12" }]
      }
    }
  ]
}
```

### Malformed input

Use `__raw_input__` in payload to send raw (non-JSON) input:

```json
{
  "steps": [{
    "event": "Stop",
    "payload": { "__raw_input__": "not json{{{" },
    "expect": { "stdout": { "ok": true } }
  }]
}
```

### Event field fallback

Use `"event": "__skip__"` to test the fallback field parsing (`event` / `eventName` instead of `hook_event_name`):

```json
{
  "steps": [{
    "event": "__skip__",
    "payload": { "event": "Stop" },
    "expect": { "stdout": { "ok": true } }
  }]
}
```

## Architecture

```
test/
├── hook-fixture.test.ts        # Test runner — auto-discovers *.fixture.json
├── tool-commands.test.ts       # Goal, hint, batch-send handler tests
├── lib/
│   ├── fixture-runner.ts       # Core runner: seeds DB, fires events, asserts
│   ├── mock-hook.ts            # MockHook wrapper for processHookEventInput
│   └── tmux-tap.ts             # TmuxTap — records sendKeys/sendCommand calls
└── fixtures/hooks/
    ├── README.md               # This file
    └── *.fixture.json          # One file per edge case
```

The fixture runner intercepts all tmux exports via `mock.module()`, recording `sendKeys`/`sendCommand` calls into a shared tap log. Each step gets its own slice of the log for step-scoped assertions. Stop events wait 2s (goal reminders use `setTimeout(1500ms)`); other events wait 50ms.

## Existing fixtures (23)

| Fixture | What it tests |
|---------|---------------|
| `stop-basic` | Basic Stop → ok response |
| `stop-with-goal` | Worker goal reminder via sendKeys |
| `stop-no-goal` | Stop without goal → no tmux |
| `stop-leader-no-armed-goal` | Leader with unarmed goal → no reminder |
| `stop-goal-truncation` | Long goal description truncated at 100 chars |
| `stop-worker-turn-count` | Turn count increments on Stop |
| `permission-request` | PermissionRequest → auto-allow with suggestions |
| `permission-no-suggestions` | PermissionRequest without suggestions |
| `user-prompt-submit-hint` | Hint fires on cadence |
| `submit-no-hint` | Submit without hint set |
| `submit-hint-not-on-cadence` | Submit before cadence → no hint |
| `submit-hint-repeats` | Hint repeats every cadence cycle |
| `malformed-json` | Malformed JSON → graceful ok |
| `unknown-pane` | Unknown pane → ok (no agent found) |
| `unknown-event-type` | Unknown event type → ok |
| `event-field-fallback` | `event`/`eventName` field fallback |
| `rapid-stop-submit` | Rapid Stop then Submit sequence |
| `multi-agent-room-stop` | Multi-agent room goal isolation |
| `multi-agent-race-stop` | Concurrent Stop events across agents |
| `multi-agent-hint-isolation` | Per-agent hint isolation |
| `leader-worker-interleave` | Interleaved leader/worker events |
| `multi-worker-rapid-submit` | Rapid submits across workers |
| `multi-agent-mixed-events` | Mixed Stop+Submit storm across agents |
