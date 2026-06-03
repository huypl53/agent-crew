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

### 3. Fallback order

Inspection should degrade gracefully:

1. `transcript`
   Claude transcript tail by current session
2. `hook-events`
   recent hook-derived status and `last_assistant_message`
3. `tmux-fallback`
   pane capture only if transcript and hook-based inspection fail

This keeps tmux scraping as the last resort rather than the primary implementation.

## Leader Tool

Add a new read-only CLI command:

```bash
crew inspect --worker wk-01 --room myroom --turns 6
```

Expected behavior:

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

## Transcript Parsing

The Claude adapter should parse only enough transcript structure to support inspection.

V1 parser behavior:

- read JSONL entries in order
- keep only normalized `user` and `assistant` conversational turns
- skip token accounting records and unrelated metadata
- return the last N conversational turns

V1 can limit scope to the currently used transcript shape instead of building a universal parser.

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
