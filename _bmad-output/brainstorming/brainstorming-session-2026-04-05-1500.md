---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: []
session_topic: 'cc-tmux: MCP server plugin for Claude Code agent-to-agent orchestration via tmux'
session_goals: '1) MCP tool API design 2) Internal tmux management layer 3) Leader-worker protocol 4) Plugin packaging'
selected_approach: 'ai-recommended'
techniques_used: ['morphological-analysis', 'first-principles-thinking', 'reverse-brainstorming-chaos-engineering']
ideas_generated: [45]
context_file: 'docs/'
technique_execution_complete: true
revision: 'Major pivot from spawn-control model to register-discover model'
---

# cc-tmux Architecture — Definitive Design Document

**Author:** lee
**Date:** 2026-04-05
**Status:** Architecture complete, ready for implementation

---

## Core Design Philosophy

**Registration-first, coordination hub, smart agents.** The MCP server is a coordination hub where Claude Code agents self-register, discover each other, and communicate through rooms. Tmux send-keys is the push delivery transport. All agents are started manually by users — spawning is an optional capability, not the default.

**Three principles:**
1. **Agents register themselves** — the server doesn't create agents, it discovers them
2. **Rooms are the grouping mechanism** — agents join rooms by role (boss/leader/worker)
3. **Dual-mode messaging** — push (tmux send-keys interrupt) for commands, pull (server-side queue) for non-urgent comms

---

## System Model

### Hierarchy
```
Boss (company room)
├── Leader-1 (company room + project-alpha room)
│   ├── Worker-1 (project-alpha room)
│   └── Worker-2 (project-alpha room)
└── Leader-2 (company room + project-beta room)
    ├── Worker-3 (project-beta room)
    └── Worker-4 (project-beta room)
```

### Interaction Model
1. Users start Claude Code sessions manually (normal CC instances)
2. Inside a CC session, user invokes `/cc-tmux:join-room <room> --role <role> --name <name>` to register
3. Agents discover each other via `list_rooms` and `list_members`
4. Communication flows through rooms: boss ↔ leaders (company room), leaders ↔ workers (project rooms)
5. An agent can be in multiple rooms (e.g., leader is in both company room and project room)

### Roles
- **Boss:** Manages leaders. Lives in the company room. Assigns high-level objectives to leaders. Receives escalations.
- **Leader:** Manages workers in a project room. Also a member of the company room for boss communication. Assigns tasks, monitors progress, reports up.
- **Worker:** Executes tasks in a project room. Receives commands from leader, reports completion.

---

## Pillar 1: MCP Tool API

### Core Tools (7 tools)

#### join_room
- **Params:** `room` (required), `role` (required: `boss | leader | worker`), `name` (required, unique within room)
- **Returns:** `{ agent_id, name, role, room, tmux_target }`
- **Behavior:** Registers calling agent in the specified room. Auto-detects tmux session/pane from `$TMUX` and `$TMUX_PANE` environment variables. If not in tmux, returns error. Optional `tmux_target` param overrides auto-detection for edge cases.
- **Multi-room:** Agent can call `join_room` multiple times for different rooms. First room joined is the primary room.

#### leave_room
- **Params:** `room` (required)
- **Returns:** `{ success: true }`
- **Behavior:** Deregisters calling agent from the specified room. Removes from member list. Unread messages in queue for this room are discarded.

#### list_rooms
- **Params:** none
- **Returns:** `{ rooms: [{ name, member_count, roles: { boss: N, leader: N, worker: N } }] }`
- **Behavior:** Returns all active rooms with member counts by role.

#### list_members
- **Params:** `room` (required)
- **Returns:** `{ room, members: [{ agent_id, name, role, status, joined_at }] }`
- **Behavior:** Returns all agents registered in the specified room with their roles and current status.

#### send_message
- **Params:** `room` (required), `to?` (agent name for directed message, omit for broadcast), `text` (required), `mode?` (default: `push` for leader→worker, `pull` for worker→leader)
- **Returns:** `{ message_id, delivered: boolean, queued: true }`
- **Behavior:**
  - **Always** writes message to target agent's server-side inbox queue.
  - **Push mode (default for commands):** Additionally delivers via tmux `send-keys -l` to target's pane with convention header `[agent-name@room-name]: message text`, then `send-keys Enter`. If target pane is dead, message is queued only, `delivered: false`.
  - **Pull mode (for status updates):** Message queued only. Target reads via `read_messages`.
  - **Broadcast:** When `to` is omitted, message sent to all members in the room (except sender). Each member gets it in their queue; push members also get tmux delivery.

#### read_messages
- **Params:** `room?` (filter by room, omit for all rooms), `since_sequence?` (cursor for incremental reads)
- **Returns:** `{ messages: [{ message_id, from, room, text, timestamp, sequence }], next_sequence }`
- **Behavior:** Reads from calling agent's server-side inbox. Returns messages since last read (or since `since_sequence`). Messages are retained until read. Cursor-based — agent tracks `next_sequence` for incremental polling.

#### get_status
- **Params:** `agent_name?` (omit for self-status), `room?`
- **Returns:** `{ agent_id, name, role, room, status, tmux_target, last_activity_ts }`
- **Status enum:** `idle | busy | dead | unknown`
- **Behavior:** For other agents: on-demand `capture-pane -p` of target's last few lines, regex match CC status line for idle/busy. Checks `tmux list-panes -F '#{pane_dead}'` for dead detection. For self: returns registration info.

### Optional Tools (enabled separately, not part of core)

#### spawn_agent
- **Params:** `project_path` (required), `room` (required), `role` (required), `name` (required), `initial_prompt?`, `model?` (default `claude-sonnet-4-6`), `worktree?` (default false)
- **Returns:** `{ agent_id, name, tmux_session, status: "spawning" }`
- **Behavior:** Creates a new tmux session named `cc-{name}`, launches `claude --model {model}` with permission bypass. Auto-registers the spawned agent in the specified room. Initial prompt sent via `send-keys` after CC ready detection. Non-blocking — returns immediately, caller polls `get_status` until `idle`.
- **Validates:** project_path exists, else error.

#### kill_agent
- **Params:** `agent_name` (required)
- **Returns:** `{ success: true }`
- **Behavior:** Hard kill via `tmux kill-session`. Deregisters from all rooms. Cleans up state. Only works on agents spawned by `spawn_agent` (identified by `cc-` prefix).

---

## Pillar 2: Tmux Management Layer

### Core Responsibilities (Minimal)
The tmux layer is a delivery mechanism, not a session manager. It does four things:

1. **Validate tmux target** — on `join_room`, verify the pane exists via `tmux list-panes -t {target}`
2. **Push delivery** — `send-keys -l "{header}: {text}"` then `send-keys Enter` to target pane
3. **Status detection** — `capture-pane -p` last few lines, regex for CC idle/busy state
4. **Liveness check** — `tmux list-panes -t {target} -F '#{pane_dead}'` for dead detection

### Input Handling
- **Always `send-keys -l`** (literal mode) for message body, then `send-keys Enter` separately. Prevents special character interpretation (semicolons, quotes, etc.).
- **Multi-line:** Works natively. CC paste detection triggers on multi-line `send-keys`, shows `[Pasted text]`, submits on final `Enter`. Confirmed behavior.
- **Push message format:** `[agent-name@room-name]: message text` — simple convention header parsed by receiving agent's skill.

### Status Detection
- **Idle/busy:** Regex against CC status line from last few lines of `capture-pane -p`. CC shows prompt character when idle, spinner/activity text when busy.
- **Dead:** `#{pane_dead}` tmux format variable.
- **On-demand only:** No background polling. Status checked when `get_status` is called.
- **CC status line regexes:** Must be calibrated empirically during implementation. First implementation task.

### Spawn-Specific Tmux (Optional feature only)
For `spawn_agent` only (not core registration flow):
- **Session naming:** `cc-{agent_name}` prefix for spawned sessions
- **Session creation:** `tmux new-session -d -s cc-{name}`
- **History limit:** `tmux set-option -t cc-{name} history-limit 50000` at creation
- **pipe-pane logging:** `pipe-pane -o "cat >> /tmp/cc-tmux/logs/{name}.log"` at creation for full output capture of spawned agents
- **Claude CLI launch:** Direct `claude --model {model}` with permission bypass flags
- **Ready detection:** Regex against CC status line via `capture-pane`. Poll until CC is responsive.

### Startup Validation
- `tmux -V` check on server init. Fail fast with clear error if tmux not installed.

---

## Pillar 3: Room-Based Communication Protocol

### Registration Flow
```
User starts CC session → User types /cc-tmux:join-room myproject --role worker --name builder-1
  → Plugin reads $TMUX + $TMUX_PANE → Calls join_room MCP tool
  → Server registers agent in room → Returns confirmation
  → Agent is now discoverable and reachable
```

### Message Flow

#### Push (Leader → Worker command)
```
Leader calls: send_message(room: "myproject", to: "builder-1", text: "fix the auth bug in src/auth.ts")
  → Server writes to builder-1's inbox queue
  → Server sends tmux send-keys to builder-1's pane: "[leader-1@myproject]: fix the auth bug in src/auth.ts"
  → Worker CC agent sees this as user input, processes it as a task
  → Worker's skill teaches it to recognize [FROM@ROOM] pattern as a leader command
```

#### Pull (Worker → Leader status update)
```
Worker calls: send_message(room: "myproject", to: "leader-1", text: "auth fix complete, 3 tests added", mode: "pull")
  → Server writes to leader-1's inbox queue
  → No tmux delivery (pull mode)
  → Leader periodically calls read_messages() to check for updates
```

#### Broadcast (Leader → All workers)
```
Leader calls: send_message(room: "myproject", text: "everyone stop, we're changing approach")
  → Server writes to every member's inbox in the room (except leader)
  → Push delivery to each worker's pane
```

#### Escalation (Leader → Boss)
```
Leader calls: send_message(room: "company", to: "boss", text: "project-alpha is blocked, need architecture decision")
  → Server writes to boss's inbox
  → Push delivery to boss's pane
  → Boss reads, decides, sends back via company room
```

### Convention: Message Format
**Push messages (appear in target's pane):**
```
[agent-name@room-name]: message text here
```

Simple, parseable, human-readable. The receiving agent's skill (`/cc-tmux:worker` or `/cc-tmux:leader` or `/cc-tmux:boss`) teaches it to recognize and act on this pattern.

### Protocol Philosophy
The server enforces message delivery and queuing. It does NOT enforce:
- Task format or structure
- Completion signaling conventions
- Progress reporting
- Error handling protocols
- Workflow patterns

All of these live in the agent skills (leader/worker/boss) as recommended patterns. Agents are Claude Code instances — smart enough to figure out coordination with guidance from their skills.

### Recommended Patterns (in skills, not enforced)

**Leader patterns:**
- Poll `get_status` for workers every 10-30s
- When worker status → idle, call `read_messages` to check for status updates
- Always read output/messages when idle — idle can mean done, question, or error
- Send tasks as natural language via push messages
- One task at a time per worker, wait for idle before sending next

**Worker patterns:**
- Recognize `[name@room]: ...` push messages as tasks from leader
- Send completion updates via pull messages: `send_message(mode: "pull", text: "task complete: ...")`
- If stuck or need help, send pull message to leader

**Boss patterns:**
- Monitor company room for leader escalations via `read_messages`
- Send strategic direction to leaders via push messages
- Use `list_rooms` + `list_members` for situational awareness

---

## Pillar 4: Plugin Packaging

### Project Structure
```
cc-tmux/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── join-room/
│   │   └── SKILL.md            # /cc-tmux:join-room slash command
│   ├── leader/
│   │   └── SKILL.md            # Leader patterns and guidance
│   ├── worker/
│   │   └── SKILL.md            # Worker patterns: handle push messages, report status
│   └── boss/
│       └── SKILL.md            # Boss patterns: manage leaders, handle escalations
├── .mcp.json                    # "bun run src/index.ts"
├── src/
│   ├── index.ts                 # MCP server entrypoint
│   ├── tools/                   # One file per tool
│   │   ├── join-room.ts
│   │   ├── leave-room.ts
│   │   ├── list-rooms.ts
│   │   ├── list-members.ts
│   │   ├── send-message.ts
│   │   ├── read-messages.ts
│   │   ├── get-status.ts
│   │   ├── spawn-agent.ts       # Optional
│   │   └── kill-agent.ts        # Optional
│   ├── tmux/                    # Thin tmux CLI wrapper
│   │   └── index.ts             # send-keys, capture-pane, list-panes, validate
│   ├── state/                   # Rooms, registry, message queues
│   │   └── index.ts             # In-memory with periodic flush to JSON files
│   └── delivery/                # Push (tmux) + pull (queue) delivery logic
│       └── index.ts
├── test/                        # Integration tests
└── package.json
```

### Runtime & Dependencies
- **Runtime:** Bun (native TS, no build step)
- **Deps:** `@modelcontextprotocol/sdk`, `strip-ansi` only. Hand-rolled tmux wrapper.
- **Launch:** `.mcp.json` → `bun run src/index.ts`

### Configuration
- **Env vars:** `CC_TMUX_PREFIX` (session prefix for spawned agents, default `cc-`), `CC_TMUX_DEFAULT_MODEL` (default `claude-sonnet-4-6`)
- **Hardcoded defaults** for everything else. No `settings.json` for v1.

### State Persistence
- **File-backed JSON** in `/tmp/cc-tmux/state/`
  - `rooms.json` — room definitions and membership
  - `messages.json` — message queues per agent (inbox)
  - `agents.json` — agent registry with tmux targets and metadata
- **In-memory primary, periodic flush to disk.** On server restart, reload from files.
- **Agents must re-register** if their tmux pane changed (e.g., after terminal restart). Server validates pane liveness on reload.

### Skills

#### `/cc-tmux:join-room` (User-invoked slash command)
The entry point for any agent. User types this to register their CC session:
```
/cc-tmux:join-room myproject --role worker --name builder-1
```
Skill invokes `join_room` MCP tool, confirms registration, and loads the appropriate role skill (leader/worker/boss).

#### `/cc-tmux:leader` (Agent skill)
Teaches the agent:
- How to use `list_members`, `send_message`, `read_messages`, `get_status`
- Recommended polling pattern (10-30s, read on status change)
- Task assignment via push messages
- Completion detection: worker idle + pull message received
- Always read messages when polling — idle can mean done, question, or error
- Escalation to boss via company room
- Multi-step workflow guidance

#### `/cc-tmux:worker` (Agent skill)
Teaches the agent:
- Recognize `[name@room]: ...` push messages as leader commands
- Report completion via pull messages
- Report errors and ask for help via pull messages
- How to read room context via `list_members`

#### `/cc-tmux:boss` (Agent skill)
Teaches the agent:
- Monitor company room for leader escalations
- Strategic direction via push messages to leaders
- Use `list_rooms` + `list_members` for organizational awareness
- Resource allocation and priority decisions

### Installation
- `--plugin-dir ./cc-tmux` for local dev (primary)
- Marketplace distribution when stable

### Testing
- **Integration tests** with real tmux sessions. Mock Claude = bash script that echoes responses and simulates idle/busy states.
- **Test scenarios:** join/leave rooms, send/read messages (push + pull), broadcast, status detection, agent liveness, server restart + state reload.
- **No isolated unit tests** for tmux wrapper — integration tests cover it.

---

## Failure Modes & Mitigations

### Handled by Design
| Scenario | Mitigation |
|---|---|
| Agent's pane dies | `get_status` returns `dead` via `#{pane_dead}`. Agent deregistered on next status check. |
| Server crashes | State reloaded from JSON files. Agents still alive in tmux. Pane liveness validated on reload. |
| Push delivery fails (agent busy) | Message always queued. Agent reads via `read_messages` later. `delivered: false` returned. |
| Agent not in tmux | `join_room` returns error. Cannot register without tmux pane. |
| tmux not installed | Startup validation via `tmux -V`. Fail fast with clear error. |
| SSH disconnect | tmux survives. Agents keep running. Reconnect and re-register. |
| Special chars in messages | `send-keys -l` (literal mode) always. Enter sent separately. |
| Multi-line messages | CC paste detection handles natively. Confirmed behavior. |
| Duplicate agent name in room | `join_room` rejects duplicate names within a room. Error returned. |
| Boss/leader/worker role mismatch | Roles are advisory. Server doesn't enforce hierarchy — skills do. |

### Handled for Spawn Feature Only
| Scenario | Mitigation |
|---|---|
| Spawned worker crashes | `get_status` returns `dead`. pipe-pane log preserved for post-mortem. |
| Permission prompts on spawned worker | Workers spawned with permission bypass. No interactive dialogs. |
| Scrollback overflow on spawned worker | `pipe-pane` log captures all output. `capture-pane` only for status. |

### Accepted for v1 (Documented)
| Scenario | Accept Rationale |
|---|---|
| Message queue growth | No auto-pruning. Manual cleanup or agent reads. |
| Multiple leaders in same room | Allowed but undocumented. Could cause conflicting instructions. |
| State file corruption | Restart server, agents re-register. Messages lost. |
| No authentication | Any MCP client on the machine can call tools. Single-user trust model. |

---

## Open Questions for Implementation

1. **CC status line regexes:** Must be calibrated empirically. First implementation task. Capture what CC actually shows in idle, busy, starting, and error states.
2. **Permission bypass flag:** Verify exact CC CLI flag or `settings.json` key for auto-accept on spawned agents.
3. **State flush frequency:** Every write? Every N seconds? On shutdown only? Decide during implementation.
4. **Message retention:** How long are read messages kept? Immediate discard after read? TTL? Decide during implementation.
5. **join-room as skill vs command:** Verify whether a Claude Code plugin skill can invoke an MCP tool directly, or if the slash command needs to be a `commands/` markdown file that instructs the agent to call the MCP tool.

---

## Design Evolution Notes

This architecture evolved through a brainstorming session using Morphological Analysis, First Principles Thinking, and Chaos Engineering techniques. A major mid-session pivot shifted from a **spawn-control model** (leader spawns and controls workers via MCP tools) to a **register-discover model** (agents self-register into rooms, communicate via dual-mode messaging).

Key insights from the pivot:
- The spawn-control model assumed top-down control. The register-discover model assumes autonomous agents that coordinate.
- Room-based grouping enables the 3-tier hierarchy (boss → leaders → workers) naturally.
- Dual-mode messaging (push + pull) solves the interrupt vs. poll tradeoff — push for commands, pull for status.
- The tmux layer got dramatically simpler — it's just a delivery mechanism, not a session lifecycle manager.
- Spawning agents is preserved as an optional capability for automation use cases, not the primary interaction.
