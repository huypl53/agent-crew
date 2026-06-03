# Worker Inspection Design

## Summary

Leaders need a way to inspect active worker conversations while the worker is still busy. The current room flow auto-sends the worker's last assistant message to leaders on `Stop`, which is useful for completions but insufficient when a worker blocks mid-turn on permissions, confirmation prompts, or other interactive waits.

This design adds a read-only leader inspection path that exposes recent worker turns without requiring the leader to wait for completion. Claude Code is the first supported provider. The design keeps provider-specific transcript access behind a gateway so Codex CLI and other providers can be added later.

## Problem

Current behavior:

- workers receive tasks via tmux push
- hooks record `UserPromptSubmit` and `Stop`
- on `Stop`, the worker's `last_assistant_message` is sent to leaders automatically

Failure mode:

- a worker can remain `busy` for a long time while waiting for permission or user input
- the leader sees neither the recent conversation tail nor the specific blocking point
- the leader must guess whether the worker is progressing, blocked, or waiting

## Goals

- Let leaders inspect the recent worker conversation while the worker is still active.
- Show both `user` and `assistant` turns, not assistant-only output.
- Keep the leader-facing tool provider-agnostic.
- Use `session_id` as the canonical identity when available.
- Preserve the existing auto-send-on-`Stop` behavior.

## Non-Goals

- No automatic worker control or interruption in v1.
- No transcript editing or replay.
- No Codex CLI or Antigravity transcript support in v1.
- No web dashboard work in v1.

## Proposed Architecture

### 1. Observation gateway

Add an internal gateway that the leader tool calls instead of reading provider storage directly.

Suggested interface:

```ts
interface AgentObservationGateway {
  inspectRecentTurns(
    agentName: string,
    options?: { roomName?: string; turns?: number },
  ): Promise<InspectionSnapshot>;
}
```

Suggested response shape:

```ts
interface InspectionSnapshot {
  agent_name: string;
  room_name: string;
  provider: string;
  session_id: string | null;
  status: 'busy' | 'idle' | 'unknown';
  updated_at: string | null;
  block_hint:
    | 'waiting_for_permission'
    | 'waiting_for_user_input'
    | 'running'
    | 'idle'
    | 'unknown';
  source: 'transcript' | 'hook-events' | 'tmux-fallback';
  turns: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: string | null;
  }>;
  degraded: boolean;
  degradation_reason:
    | 'none'
    | 'transcript_unavailable'
    | 'session_unresolved'
    | 'hook_only'
    | 'tmux_only';
}
```

The leader CLI should only know how to render `InspectionSnapshot`.

### 2. Claude-first provider adapter

Add a Claude-specific adapter that resolves the worker session and reads the recent transcript tail.

Primary strategy:

1. Resolve the worker agent.
2. Read its provider and tmux/session metadata.
3. Use `session_id` if already known.
4. If `session_id` is not yet stored on the agent record, resolve it from pane to Claude PID to session metadata.
5. Read the transcript JSONL for the current Claude session.
6. Extract the last N `user` and `assistant` turns and normalize them.

Existing code already provides useful building blocks:

- pane to Claude session resolution in `src/tokens/pid-mapper.ts`
- hook-event persistence with `session_id`
- worker status derived from recent hook events

### 2a. Authorization and room scoping

`crew inspect` must follow the same room and role boundaries as other leader-facing coordination tools.

V1 rules:

- only a `leader` may inspect a worker
- the caller must be a member of the target room
- the target agent must be a `worker` in that same room
- if `--room` is omitted, auto-resolution is allowed only when the worker name matches exactly one room visible to the caller
- if the worker name is ambiguous across rooms, the command must fail and require `--room`
- leaders may not inspect workers in rooms they have not joined

This keeps inspection aligned with existing crew trust boundaries and prevents accidental cross-room transcript access.

### 3. Fallback order

Inspection should degrade gracefully:

1. `transcript`
   Claude transcript tail by current session
2. `hook-events`
   recent hook-derived status and `last_assistant_message`
3. `tmux-fallback`
   pane capture only if transcript and hook-based inspection fail

This keeps tmux scraping as the last resort rather than the primary implementation.

Degraded output rules:

- `transcript` source may return full recent `user` and `assistant` turns
- `hook-events` source cannot promise recent `user` turns with current data; when used, output may contain only the most recent assistant-visible content plus status metadata
- `tmux-fallback` source is best-effort text capture and may not preserve turn boundaries reliably

The CLI must surface degradation explicitly using `source`, `degraded`, and `degradation_reason` rather than pretending all sources provide equivalent fidelity.

## Leader Tool

Add a new read-only CLI command:

```bash
crew inspect --worker wk-01 --room myroom --turns 6
```

Expected behavior:

- verify caller authorization and room membership before any inspection
- resolve the worker in the specified room
- call the observation gateway
- print a normalized inspection snapshot
- never modify task state, room state, or worker state

Suggested text output:

```text
worker: wk-01
provider: claude-code
session_id: abc123
status: busy
updated_at: 2026-06-03T14:22:10Z
block_hint: waiting_for_permission
source: transcript

[user] Please update auth middleware and run tests.
[assistant] I found the auth middleware entry point in src/server/auth.ts.
[user] Focus only on the failing test path.
[assistant] I updated the middleware, but test execution needs permission to access ...
```

Suggested degraded output:

```text
worker: wk-01
room: myroom
provider: claude-code
session_id: null
status: busy
updated_at: 2026-06-03T14:22:10Z
block_hint: unknown
source: hook-events
degraded: true
degradation_reason: session_unresolved

[assistant] Last captured message: I am blocked waiting for permission to run tests.
```

## Transcript Parsing

The Claude adapter should parse only enough transcript structure to support inspection.

V1 parser behavior:

- favor tail-oriented parsing so `inspect` does not require a full scan for typical sessions
- allow a bounded full-file scan fallback in v1 when the file is small enough or tail parsing cannot find enough turns
- keep only normalized conversational turns that map cleanly to leader-visible `user` and `assistant` messages
- skip token accounting records and unrelated metadata
- return the last N conversational turns

V1 can limit scope to the currently used transcript shape instead of building a universal parser.

Practical constraints:

- target the last `N` turns, not a complete transcript replay
- prefer reading from the end of the JSONL file in bounded chunks
- if a bounded backward read is too complex for the first cut, permit a full-file scan only behind a conservative size cap
- if the transcript exceeds the v1 cap and tail parsing is unavailable, return degraded output instead of blocking the command for an unbounded read

### Turn filtering rules

V1 should expose only the conversational exchange that helps a leader understand worker progress.

Include:

- user task prompts delivered into the worker conversation
- assistant responses visible as the worker's natural language progress

Exclude:

- raw tool call payloads
- token accounting entries
- hook-injected hint text unless it is persisted as a normal user-visible turn
- low-level metadata records
- internal system-only records that would confuse the leader more than help them

If a transcript entry cannot be mapped confidently to `user` or `assistant`, the adapter should drop it in v1 rather than guess.

## Block Detection

V1 block detection should be heuristic only.

Initial categories:

- `waiting_for_permission`
- `waiting_for_user_input`
- `running`
- `idle`
- `unknown`

Suggested rules:

- if latest status is `idle`, return `idle`
- if recent assistant text includes permission or approval language, return `waiting_for_permission`
- if recent assistant text asks a direct question or requests confirmation, return `waiting_for_user_input`
- if busy with recent transcript activity, return `running`
- otherwise return `unknown`

These heuristics must remain advisory. They do not change worker execution.

## Data Model Notes

`session_id` should be the canonical provider-session identity because it survives tmux reattach better than pane identity alone. The gateway should still support pane-based bootstrap resolution because a worker may not have emitted a usable `session_id` yet.

### Timestamp semantics

Timestamp fields must remain comparable across inspection sources.

- `turns[].timestamp` should be the provider transcript timestamp when available
- for hook-only fallback, `turns[].timestamp` should use the corresponding hook-event creation time when a synthetic assistant line is emitted
- for tmux fallback, `turns[].timestamp` may be `null` if no trustworthy event time exists
- `updated_at` should represent the newest underlying observation used in the snapshot, not CLI render time

This means:

- transcript source: `updated_at` is the latest included transcript event timestamp
- hook-events source: `updated_at` is the latest relevant hook-event timestamp
- tmux-fallback source: `updated_at` may use pane capture time only if no better source exists

The CLI should not imply stronger temporal precision than the underlying source can provide.

The existing hook-events store remains valuable even after transcript inspection exists:

- provider-neutral busy/idle status
- fallback visibility when transcript access fails
- future cross-provider event normalization

## Implementation Plan Boundary

V1 implementation should cover:

- gateway interface
- Claude observation adapter
- transcript tail extraction for recent `user` and `assistant` turns
- `crew inspect` command
- hook-events fallback path
- authorization and room-scoping checks
- tests for transcript parsing and inspection fallback behavior

V1 should not include:

- continuous watch mode
- dashboard integration
- Codex CLI adapter
- Antigravity adapter

## Risks

- Claude transcript format may change over time.
- Session resolution may fail for edge cases where pane-to-process lookup is unavailable.
- Busy workers may produce partial states that are hard to classify correctly with heuristics alone.

These risks are acceptable for v1 because the tool is observational and has defined fallbacks.

## Recommendation

Implement a hybrid observation design:

- provider-agnostic inspection gateway
- Claude transcript reader as the primary source
- hook-events and tmux capture as fallbacks

This solves the current leader visibility problem immediately for Claude Code while preserving a clean extension path for future providers.
