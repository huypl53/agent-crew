# Agent TUI Detection

This repo can usually detect whether `crew` is running inside a Claude Code or Codex TUI when an agent joins a room.

## Primary detection path

The main detection logic lives in `crew/src/tools/join-room.ts`:

- `handleJoinRoom()` uses `TMUX_PANE` when `crew join` is invoked from inside tmux.
- If `CREW_TMUX_SOCKET` is set, tmux inspection commands run against that socket instead of the default tmux server. This is primarily used by isolated tests and UAT harnesses.
- `detectAgentType()` reads the pane PID via:
  - `tmux display-message -p -t <pane> '#{pane_pid}'`
- It then inspects child processes of that pane PID:
  - `ps -o comm= --ppid <shellPid>`
  - fallback: `pgrep -P <shellPid>` and `ps -p <childPid> -o comm=`
- If a child command contains `claude`, the agent type is classified as `claude-code`.
- If a child command contains `codex`, the agent type is classified as `codex`.
- Otherwise it falls back to `unknown`.

Relevant code:

- `crew/src/tools/join-room.ts`
  - `detectAgentType()`
  - `handleJoinRoom()`
- `crew/src/tmux/index.ts`
- `crew/src/tokens/pid-mapper.ts`

## Where the result is stored

The detected type is passed into `addAgent()` and stored on the agent record as `agent_type`.

Relevant code:

- `crew/src/tools/join-room.ts`
- `crew/src/shared/types.ts`
  - `Agent.agent_type`
- `crew/src/state/index.ts`
  - `addAgent(...)`

Known values:

- `claude-code`
- `codex`
- `unknown`

## Liveness polling is separate

The ongoing polling/liveness path is not the same as agent-type detection.

`crew/src/tmux/index.ts` contains:

- `getPaneCurrentCommand()`
  - reads tmux `#{pane_current_command}`
- `paneCommandLooksAlive()`
  - treats commands matching `node|bun|claude|codex` as a live agent-like process

That logic is used by:

- `crew/src/state/index.ts`
  - `validateLiveness()`
- `crew/src/tools/get-status.ts`
  - pane dead / status checks

This means:

- join-time logic can usually distinguish `claude-code` vs `codex`
- liveness logic mainly answers whether the pane still looks like an agent process

## Practical limitation

The current implementation does not persist the full runtime launch command for a running agent. It detects the agent family from process names, not the exact invocation arguments.

Examples:

- detectable: `claude` vs `codex`
- not retained today: full command such as `claude --dangerously-skip-permissions`

## Test and harness usage

For repo tests, tmux-aware code should not touch the developer's live tmux server.

- unit and integration tests use isolated sockets via `CREW_TMUX_SOCKET`
- `crew/test/helpers.ts` creates per-process sockets like `crew-test-<pid>`
- some UAT flows use dedicated sockets such as `crew-uat-edge`

When adding new tmux subprocess calls, route them through the configured socket if `CREW_TMUX_SOCKET` is present. Otherwise tests can accidentally inspect or send input to a real interactive session.

## Summary

Yes, when `crew` is run from inside the Claude Code or Codex TUI in tmux, this repo can usually detect which one it is. The reliable path for that is the join flow in `crew/src/tools/join-room.ts`; the liveness poll in `crew/src/tmux/index.ts` is broader and less specific.
