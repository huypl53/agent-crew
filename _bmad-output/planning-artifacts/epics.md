---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
status: 'complete'
completedAt: '2026-04-05'
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-04-05-1500.md'
---

# cc-tmux - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for cc-tmux, decomposing the requirements from the PRD and Architecture into implementable stories. Scope: MVP only (7 core MCP tools, 4 skills, state/tmux/delivery modules, integration tests). No spawn_agent, kill_agent, or Phase 2 features.

## Requirements Inventory

### Functional Requirements

FR1: An agent can register itself in a named room with a role (boss, leader, or worker) and a unique name
FR2: An agent can deregister itself from a room
FR3: An agent can be a member of multiple rooms simultaneously
FR4: The system can auto-detect the agent's tmux session and pane from environment variables during registration
FR5: The system can reject registration if the agent is not running inside a tmux pane
FR6: The system can reject registration if the agent name is already taken within the target room
FR7: An agent can override auto-detected tmux target with an explicit parameter
FR8: An agent can list all active rooms with member counts and role breakdown
FR9: An agent can list all members of a specific room with their names, roles, and current status
FR10: An agent can query the status of any registered agent (idle, busy, dead, unknown)
FR11: An agent can send a directed push message to a specific agent in a room, delivered as text input to the target's tmux pane
FR12: An agent can send a broadcast push message to all members of a room
FR13: Push messages are delivered with a convention header identifying the sender and room (`[name@room]: text`)
FR14: The system can report whether push delivery succeeded (target pane alive) or failed (target pane dead)
FR15: An agent can send a pull-mode message that is queued server-side without tmux delivery
FR16: An agent can read messages from its inbox with cursor-based incremental retrieval
FR17: An agent can filter inbox messages by room
FR18: All messages (push and pull) are stored in the server-side inbox queue regardless of delivery mode
FR19: The system can detect whether a registered agent's tmux pane is alive or dead
FR20: The system can detect whether a Claude Code agent is idle or busy by inspecting the tmux pane content
FR21: Status detection occurs on-demand when queried, not via background polling
FR22: The system can persist room definitions, agent registrations, and message queues to disk
FR23: The system can restore state from disk on server restart
FR24: The system can validate registered agent pane liveness on state reload and mark dead agents
FR25: The system can validate that tmux is installed and available at startup
FR26: The system can fail fast with a clear error message if tmux is not found
FR27: The system can accept MCP tool calls from any Claude Code session that has the plugin configured
FR28: A user can invoke a slash command to register their agent in a room (`/cc-tmux:join-room`)
FR29: A leader agent can access guidance on polling patterns, task assignment, and completion detection
FR30: A worker agent can access guidance on recognizing push message commands and reporting status
FR31: A boss agent can access guidance on managing leaders, handling escalations, and organizational awareness
FR32: The system can deliver multi-line text messages via tmux without corruption
FR33: The system can deliver messages containing special characters (semicolons, quotes, brackets) without corruption
FR34: The system can strip ANSI escape codes from tmux capture output before returning to agents

### NonFunctional Requirements

NFR1: MCP tool calls must respond within 1 second under normal operation (<=20 registered agents)
NFR2: Push message delivery (tool call -> tmux send-keys -> visible in target pane) must complete within 500ms
NFR3: `read_messages` with up to 100 queued messages must respond within 200ms
NFR4: State flush to disk must not block tool call processing
NFR5: Server startup (including tmux validation and state reload) must complete within 5 seconds
NFR6: All messages must be persisted to the server-side queue before returning success to the caller
NFR7: Server restart must recover rooms, agent registrations, and unread messages from disk
NFR8: Dead agent detection must correctly identify panes that no longer exist (zero false negatives on dead panes)
NFR9: Push delivery failure (dead pane) must not cause message loss — message remains in queue for pull retrieval
NFR10: Concurrent tool calls from multiple agents must not corrupt shared state
NFR11: MCP server must conform to the MCP protocol specification compatible with current Claude Code (v2.1+)
NFR12: Plugin structure must conform to Claude Code plugin specification (`.claude-plugin/plugin.json`, skills in `skills/`, MCP config in `.mcp.json`)
NFR13: tmux wrapper must support tmux 3.0 and later
NFR14: Must run on Linux and macOS (platforms where both tmux and Claude Code are available)

### Additional Requirements

- From-scratch Bun/TypeScript project initialization (no starter template)
- tmux startup validation with fail-fast error if tmux not installed
- Write-through state flush to `/tmp/cc-tmux/state/` (agents.json, rooms.json, messages.json)
- ANSI stripping via `strip-ansi` on all `capture-pane` output in tmux module
- CC status line regex calibration as empirical first implementation task
- Module boundaries enforced: `src/tools/`, `src/tmux/`, `src/state/`, `src/delivery/`
- MCP-compliant JSON text responses from all tool handlers
- Plugin packaging: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/` directory
- Integration tests with real tmux sessions and mock Claude (bash echo script)

### UX Design Requirements

N/A — cc-tmux is a developer tool (MCP server + skills) with no graphical UI.

### FR Coverage Map

| FR | Epic | Description |
|---|---|---|
| FR1 | Epic 2 | Agent registers in room with role and name |
| FR2 | Epic 2 | Agent deregisters from room |
| FR3 | Epic 2 | Agent in multiple rooms simultaneously |
| FR4 | Epic 2 | Auto-detect tmux session/pane from env vars |
| FR5 | Epic 2 | Reject registration if not in tmux |
| FR6 | Epic 2 | Reject duplicate name in room |
| FR7 | Epic 2 | Override auto-detected tmux target |
| FR8 | Epic 2 | List all active rooms with counts |
| FR9 | Epic 2 | List all members of a room |
| FR10 | Epic 4 | Query agent status (idle/busy/dead) |
| FR11 | Epic 3 | Directed push message via tmux send-keys |
| FR12 | Epic 3 | Broadcast push message to room |
| FR13 | Epic 3 | Push messages with [name@room] header |
| FR14 | Epic 3 | Report push delivery success/failure |
| FR15 | Epic 3 | Pull-mode message queued server-side |
| FR16 | Epic 3 | Cursor-based inbox read |
| FR17 | Epic 3 | Filter inbox by room |
| FR18 | Epic 3 | All messages stored in queue regardless of mode |
| FR19 | Epic 4 | Detect pane alive or dead |
| FR20 | Epic 4 | Detect CC idle or busy via pane content |
| FR21 | Epic 4 | Status detection on-demand only |
| FR22 | Epic 5 | Persist state to disk |
| FR23 | Epic 5 | Restore state on restart |
| FR24 | Epic 5 | Validate pane liveness on reload |
| FR25 | Epic 1 | Validate tmux installed at startup |
| FR26 | Epic 1 | Fail fast if tmux not found |
| FR27 | Epic 1 | Accept MCP tool calls from any configured session |
| FR28 | Epic 6 | join-room slash command skill |
| FR29 | Epic 6 | Leader guidance skill |
| FR30 | Epic 6 | Worker guidance skill |
| FR31 | Epic 6 | Boss guidance skill |
| FR32 | Epic 3 | Multi-line message delivery |
| FR33 | Epic 3 | Special character message delivery |
| FR34 | Epic 4 | Strip ANSI from capture output |

## Epic List

### Epic 1: Project Foundation & MCP Server
Developers can install the cc-tmux plugin and have a running MCP server that validates its environment.
**FRs covered:** FR25, FR26, FR27
**NFRs addressed:** NFR5, NFR11, NFR12, NFR13, NFR14

### Epic 2: Room Registration & Discovery
Agents can register themselves into named rooms with roles, leave rooms, and discover who else is in any room.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9
**NFRs addressed:** NFR1, NFR10

### Epic 3: Agent Messaging
Agents can communicate through rooms via push messages (tmux send-keys) and pull messages (server-side queue), including broadcast to all room members.
**FRs covered:** FR11, FR12, FR13, FR14, FR15, FR16, FR17, FR18, FR32, FR33
**NFRs addressed:** NFR2, NFR3, NFR6, NFR9

### Epic 4: Agent Status Detection
Agents can check whether other agents are idle, busy, or dead by inspecting their tmux panes on-demand.
**FRs covered:** FR10, FR19, FR20, FR21, FR34
**NFRs addressed:** NFR1, NFR8

### Epic 5: State Persistence & Recovery
The system persists all state to disk and recovers gracefully on server restart, validating agent liveness.
**FRs covered:** FR22, FR23, FR24
**NFRs addressed:** NFR4, NFR7, NFR10

### Epic 6: Agent Role Skills
Agents can invoke role-specific skills that teach them how to coordinate as boss, leader, or worker within the room hierarchy.
**FRs covered:** FR28, FR29, FR30, FR31

### Epic 7: Integration Testing & Validation
End-to-end integration tests prove the complete system works with real tmux sessions and mock Claude agents.
**FRs validated:** All FRs (FR1-FR34)

---

## Epic 1: Project Foundation & MCP Server

Developers can install the cc-tmux plugin and have a running MCP server that validates its environment.

### Story 1.1: Project Scaffolding & Plugin Packaging

As a developer,
I want to initialize the cc-tmux project with correct plugin structure and dependencies,
So that Claude Code recognizes it as a valid plugin when loaded via `--plugin-dir`.

**Acceptance Criteria:**

**Given** a fresh directory
**When** the project is initialized with `bun init` and dependencies installed
**Then** `package.json` exists with `@modelcontextprotocol/sdk` and `strip-ansi` as dependencies
**And** `.claude-plugin/plugin.json` exists with valid plugin manifest (name: "cc-tmux", version, description)
**And** `.mcp.json` exists with `{ "mcpServers": { "cc-tmux": { "command": "bun", "args": ["run", "src/index.ts"] } } }`
**And** `tsconfig.json` exists with Bun-compatible TypeScript config
**And** directory structure matches architecture: `src/tools/`, `src/tmux/`, `src/state/`, `src/delivery/`, `skills/`, `test/`
**And** `.gitignore` excludes `node_modules/`, `/tmp/cc-tmux/`

### Story 1.2: MCP Server Entrypoint with tmux Validation

As a developer,
I want the MCP server to start, validate tmux availability, and accept tool calls over stdio,
So that Claude Code sessions can connect to cc-tmux and invoke tools.

**Acceptance Criteria:**

**Given** the plugin is loaded via `--plugin-dir`
**When** Claude Code starts the MCP server via `bun run src/index.ts`
**Then** the server runs `tmux -V` to validate tmux is installed (FR25)
**And** if tmux is not found, the server exits with a clear error message: "cc-tmux requires tmux to be installed and available on PATH" (FR26)
**And** the server initializes MCP `Server` with `StdioServerTransport` conforming to MCP protocol (NFR11)
**And** the server registers tool stubs for all 7 core tools (join_room, leave_room, list_rooms, list_members, send_message, read_messages, get_status)
**And** any configured Claude Code session can invoke the registered tools (FR27)
**And** server startup completes within 5 seconds (NFR5)

---

## Epic 2: Room Registration & Discovery

Agents can register themselves into named rooms with roles, leave rooms, and discover who else is in any room.

### Story 2.1: State Module for Agents & Rooms

As a developer,
I want an in-memory state module that manages agents and rooms,
So that all tools have a consistent data layer to register, query, and remove agents and rooms.

**Acceptance Criteria:**

**Given** the state module is imported by tool handlers
**When** `addAgent()` is called with agent data (name, role, room, tmux_target)
**Then** the agent is stored in memory and retrievable via `getAgent(name)`
**And** the room is created if it doesn't exist, or the agent is added to the existing room
**And** `getRoom(roomName)` returns the room with its member list
**And** `removeAgent(name, room)` removes the agent from the room and deletes the room if empty
**And** `getAllRooms()` returns all rooms with member counts and role breakdowns
**And** `getRoomMembers(room)` returns all agents in a room with their details
**And** concurrent calls do not corrupt state (single-threaded event loop guarantees this) (NFR10)

### Story 2.2: join_room Tool

As an agent,
I want to register myself in a named room with a role and name,
So that other agents can discover me and I can participate in room communication.

**Acceptance Criteria:**

**Given** an agent running in a tmux pane
**When** the agent calls `join_room` with `room`, `role` (boss|leader|worker), and `name`
**Then** the server auto-detects `$TMUX` and `$TMUX_PANE` environment variables to determine the agent's tmux target (FR4)
**And** the server validates the tmux pane exists via `tmux list-panes -t {target}` (FR5)
**And** if the pane doesn't exist or agent is not in tmux, an error is returned (FR5)
**And** if the name is already taken in the room, an error is returned (FR6)
**And** the agent is registered and the response includes `{ agent_id, name, role, room, tmux_target }` (FR1)
**And** an agent can call `join_room` multiple times for different rooms (FR3)
**And** if `tmux_target` param is provided, it overrides auto-detection (FR7)
**And** the tool responds within 1 second (NFR1)

### Story 2.3: leave_room Tool

As an agent,
I want to deregister myself from a room,
So that I'm no longer discoverable in that room and stop receiving messages for it.

**Acceptance Criteria:**

**Given** an agent registered in a room
**When** the agent calls `leave_room` with `room`
**Then** the agent is removed from the room's member list (FR2)
**And** unread messages for that room in the agent's inbox are discarded
**And** the response is `{ success: true }`
**And** if the agent is not in the specified room, an error is returned
**And** the room is removed if no members remain

### Story 2.4: list_rooms Tool

As an agent,
I want to see all active rooms with member counts and role breakdown,
So that I can discover what coordination groups exist.

**Acceptance Criteria:**

**Given** one or more rooms exist with registered agents
**When** an agent calls `list_rooms` (no params)
**Then** the response includes `{ rooms: [{ name, member_count, roles: { boss: N, leader: N, worker: N } }] }` (FR8)
**And** empty rooms (no members) are not included
**And** the response is accurate at the time of the call

### Story 2.5: list_members Tool

As an agent,
I want to see all agents in a specific room with their names, roles, and status,
So that I can understand who I'm coordinating with.

**Acceptance Criteria:**

**Given** a room exists with registered agents
**When** an agent calls `list_members` with `room`
**Then** the response includes `{ room, members: [{ agent_id, name, role, status, joined_at }] }` (FR9)
**And** status defaults to `unknown` until Epic 4 (get_status) is implemented
**And** if the room doesn't exist, an error is returned
**And** the tool responds within 1 second (NFR1)

---

## Epic 3: Agent Messaging

Agents can communicate through rooms via push messages (tmux send-keys) and pull messages (server-side queue), including broadcast to all room members.

### Story 3.1: Message Queue in State Module

As a developer,
I want the state module to support per-agent message inbox queues,
So that all messages are reliably stored server-side regardless of delivery mode.

**Acceptance Criteria:**

**Given** the state module manages agent inboxes
**When** `addMessage(to, message)` is called with sender, room, text, and mode
**Then** the message is assigned a monotonically increasing sequence number per inbox
**And** the message is stored with `{ message_id, from, room, text, timestamp, sequence }`
**And** messages are persisted to the agent's inbox before the function returns (NFR6)
**And** `readMessages(agentName, room?, sinceSequence?)` returns messages matching the filter
**And** `readMessages` returns `{ messages: [...], next_sequence }` for cursor-based retrieval

### Story 3.2: tmux Send-Keys Wrapper

As a developer,
I want a tmux wrapper function that delivers text to a target pane via send-keys,
So that push messages can be reliably delivered to agent panes.

**Acceptance Criteria:**

**Given** a valid tmux target (session:window.pane)
**When** `sendKeys(target, text)` is called
**Then** the function executes `tmux send-keys -t {target} -l "{text}"` followed by `tmux send-keys -t {target} Enter`
**And** literal mode (`-l`) is always used to prevent special character interpretation (FR33)
**And** multi-line text is sent as-is (CC paste detection handles it) (FR32)
**And** if the target pane is dead or missing, the function returns `{ delivered: false }` instead of throwing
**And** all tmux commands are executed via `Bun.spawn()`

### Story 3.3: Directed Push Messaging

As an agent,
I want to send a message to a specific agent in a room, delivered directly to their tmux pane,
So that I can give commands or send information that the target agent acts on immediately.

**Acceptance Criteria:**

**Given** sender and target are both registered in the same room
**When** sender calls `send_message` with `room`, `to` (target name), `text`, and `mode: "push"` (default)
**Then** the message is written to the target's server-side inbox queue (FR18)
**And** the message is delivered to the target's tmux pane via send-keys with header `[sender-name@room-name]: message text` (FR11, FR13)
**And** the response includes `{ message_id, delivered: true, queued: true }` (FR14)
**And** if the target pane is dead, message is queued only with `{ delivered: false, queued: true }` (FR14, NFR9)
**And** push delivery completes within 500ms (NFR2)

### Story 3.4: Broadcast & Pull Messaging

As an agent,
I want to broadcast messages to all room members or send pull-only messages that don't interrupt,
So that I can coordinate with everyone or send non-urgent updates.

**Acceptance Criteria:**

**Given** an agent registered in a room with other members
**When** the agent calls `send_message` with `room`, `text`, and no `to` param
**Then** the message is sent to all members in the room except the sender (FR12)
**And** each member receives the message in their inbox queue and via push delivery

**Given** an agent wants to send a non-interrupting message
**When** the agent calls `send_message` with `mode: "pull"`
**Then** the message is written to the target's inbox queue only (FR15)
**And** no tmux send-keys delivery occurs
**And** the response includes `{ delivered: false, queued: true }`

### Story 3.5: read_messages Tool

As an agent,
I want to read messages from my inbox with cursor-based incremental retrieval,
So that I can check for updates and commands from other agents.

**Acceptance Criteria:**

**Given** an agent has unread messages in their inbox
**When** the agent calls `read_messages` with no params
**Then** all unread messages are returned with `{ messages: [...], next_sequence }` (FR16)
**And** subsequent calls with `since_sequence` return only newer messages (cursor-based)

**Given** an agent wants messages from a specific room only
**When** the agent calls `read_messages` with `room` param
**Then** only messages from that room are returned (FR17)

**Given** an agent has 100 queued messages
**When** the agent calls `read_messages`
**Then** the response completes within 200ms (NFR3)

---

## Epic 4: Agent Status Detection

Agents can check whether other agents are idle, busy, or dead by inspecting their tmux panes on-demand.

### Story 4.1: tmux Capture & Liveness Detection

As a developer,
I want tmux wrapper functions for capturing pane content and checking pane liveness,
So that the get_status tool can determine agent state.

**Acceptance Criteria:**

**Given** a registered agent's tmux target
**When** `capturePane(target)` is called
**Then** it executes `tmux capture-pane -t {target} -p` and returns the last lines of output
**And** all ANSI escape codes are stripped via `strip-ansi` before returning (FR34)

**Given** a tmux target
**When** `isPaneDead(target)` is called
**Then** it executes `tmux list-panes -t {target} -F '#{pane_dead}'`
**And** returns `true` if pane is dead, `false` if alive (FR19)
**And** returns `true` if the target doesn't exist (zero false negatives on dead detection) (NFR8)

### Story 4.2: get_status Tool with CC Status Line Detection

As an agent,
I want to check the status of another agent (idle, busy, or dead),
So that I can know when to send tasks or read output.

**Acceptance Criteria:**

**Given** a registered agent's name
**When** an agent calls `get_status` with `agent_name`
**Then** the server checks pane liveness first — if dead, returns `{ status: "dead" }` (FR19)
**And** if alive, captures the last few lines of the pane and applies regex to detect CC status line (FR20)
**And** returns `{ agent_id, name, role, room, status, tmux_target, last_activity_ts }` (FR10)
**And** status is one of: `idle`, `busy`, `dead`, `unknown` (FR10)
**And** detection occurs on-demand only, no background polling (FR21)
**And** the tool responds within 1 second (NFR1)

**Given** no `agent_name` param is provided
**When** an agent calls `get_status`
**Then** the server returns the calling agent's own registration info

**Note:** CC status line regexes must be calibrated empirically during implementation. Initial patterns will match known CC prompt/spinner indicators and can be refined.

---

## Epic 5: State Persistence & Recovery

The system persists all state to disk and recovers gracefully on server restart, validating agent liveness.

### Story 5.1: State Persistence to JSON Files

As a developer,
I want all state (agents, rooms, messages) flushed to JSON files on disk,
So that state survives server crashes and can be recovered on restart.

**Acceptance Criteria:**

**Given** the state module manages in-memory state
**When** any state mutation occurs (agent add/remove, message add/read, room change)
**Then** the affected state is flushed to the corresponding JSON file in `/tmp/cc-tmux/state/` (FR22)
**And** `agents.json` contains all registered agents with their metadata
**And** `rooms.json` contains all room definitions with membership
**And** `messages.json` contains all per-agent inbox queues
**And** the state directory is created if it doesn't exist
**And** state flush uses `Bun.write()` and does not block tool call processing (NFR4)

### Story 5.2: State Recovery & Liveness Validation on Restart

As a developer,
I want the server to reload state from disk on restart and validate that registered agents are still alive,
So that the system recovers gracefully and doesn't retain stale agent registrations.

**Acceptance Criteria:**

**Given** JSON state files exist in `/tmp/cc-tmux/state/`
**When** the MCP server starts and detects existing state files
**Then** it loads agents, rooms, and messages from the JSON files (FR23)
**And** for each loaded agent, it validates the tmux pane is still alive via `isPaneDead()` (FR24)
**And** agents with dead panes are marked as dead and removed from room memberships
**And** rooms with no remaining live members are removed
**And** unread messages for dead agents are discarded
**And** the recovery process completes within the 5-second startup window (NFR5)
**And** state recovered from disk is consistent and not corrupted by concurrent access (NFR7, NFR10)

---

## Epic 6: Agent Role Skills

Agents can invoke role-specific skills that teach them how to coordinate as boss, leader, or worker within the room hierarchy.

### Story 6.1: join-room Slash Command Skill

As a user,
I want to type `/cc-tmux:join-room <room> --role <role> --name <name>` in my Claude Code session,
So that my agent registers in a room and loads the appropriate role behavior.

**Acceptance Criteria:**

**Given** a user in a Claude Code session with cc-tmux plugin loaded
**When** the user types `/cc-tmux:join-room myproject --role worker --name builder-1`
**Then** the skill instructs the agent to call the `join_room` MCP tool with the provided params (FR28)
**And** on successful registration, the skill confirms: "Registered as builder-1 (worker) in room myproject"
**And** the skill loads the corresponding role guidance (leader/worker/boss skill content)
**And** `skills/join-room/SKILL.md` exists with clear instructions for parsing args and invoking the tool

### Story 6.2: Worker Skill

As a worker agent,
I want guidance on how to recognize commands from my leader and report status,
So that I can effectively execute tasks and communicate within the room hierarchy.

**Acceptance Criteria:**

**Given** an agent has joined a room as a worker
**When** the worker skill is active
**Then** `skills/worker/SKILL.md` teaches the agent to recognize `[name@room]: ...` push messages as leader commands (FR30)
**And** teaches the agent to report task completion via pull messages: `send_message(mode: "pull", text: "task complete: ...")`
**And** teaches the agent to send error/help requests via pull messages to the leader
**And** teaches the agent to use `list_members` to understand room context
**And** the skill content is clear, actionable natural language guidance

### Story 6.3: Leader Skill

As a leader agent,
I want guidance on how to poll workers, assign tasks, and detect completion,
So that I can effectively coordinate worker agents in my project room.

**Acceptance Criteria:**

**Given** an agent has joined a room as a leader
**When** the leader skill is active
**Then** `skills/leader/SKILL.md` teaches the agent recommended polling patterns (check `get_status` every 10-30s) (FR29)
**And** teaches task assignment via push messages to workers
**And** teaches completion detection: worker idle + pull message received
**And** teaches to always call `read_messages` when polling — idle can mean done, question, or error
**And** teaches escalation to boss via the company room: `send_message(room: "company", to: "boss", ...)`
**And** teaches one task at a time per worker, wait for idle before sending next
**And** the skill content is clear, actionable natural language guidance

### Story 6.4: Boss Skill

As a boss agent,
I want guidance on how to manage leaders, handle escalations, and maintain organizational awareness,
So that I can effectively steer the entire multi-agent operation.

**Acceptance Criteria:**

**Given** an agent has joined a room as a boss
**When** the boss skill is active
**Then** `skills/boss/SKILL.md` teaches the agent to monitor the company room for leader escalations via `read_messages` (FR31)
**And** teaches strategic direction via push messages to leaders
**And** teaches use of `list_rooms` + `list_members` for situational awareness across all rooms
**And** teaches resource allocation and priority decisions
**And** teaches the agent that it represents the human's intent in the hierarchy
**And** the skill content is clear, actionable natural language guidance

---

## Epic 7: Integration Testing & Validation

End-to-end integration tests prove the complete system works with real tmux sessions and mock Claude agents.

### Story 7.1: Test Infrastructure

As a developer,
I want a mock Claude script and test helpers for creating/tearing down tmux sessions,
So that integration tests can run with real tmux but without requiring actual Claude Code instances.

**Acceptance Criteria:**

**Given** the test directory exists
**When** test infrastructure is set up
**Then** `test/mock-claude.sh` exists as a bash script that simulates Claude Code behavior (echoes input, shows a status line, transitions between idle/busy states)
**And** `test/helpers.ts` provides functions: `createTestSession(name)`, `destroyTestSession(name)`, `sendToPane(target, text)`, `captureFromPane(target)`
**And** helpers use `Bun.spawn()` to manage tmux sessions
**And** helpers handle cleanup of test sessions even on test failure
**And** the mock Claude script displays a recognizable status line that matches CC regex patterns

### Story 7.2: Integration Test Suite

As a developer,
I want a comprehensive integration test suite that validates the full tool lifecycle with real tmux,
So that I have confidence the system works end-to-end before release.

**Acceptance Criteria:**

**Given** the test infrastructure from Story 7.1 is available
**When** `bun test` is run
**Then** tests validate the following scenarios:

**Registration & Discovery:**
- Agent joins a room and appears in `list_members`
- Agent joins multiple rooms and appears in both
- Duplicate name in same room is rejected
- Agent not in tmux is rejected
- Agent leaves room and disappears from `list_members`
- `list_rooms` shows correct member counts and role breakdown

**Messaging:**
- Directed push message appears in target's tmux pane with correct `[name@room]` header
- Pull message is queued but does not appear in target's pane
- Broadcast message reaches all room members except sender
- `read_messages` returns messages with correct cursor-based pagination
- `read_messages` with room filter returns only messages from that room
- Multi-line messages are delivered without corruption
- Special characters (semicolons, quotes, brackets) are delivered without corruption

**Status:**
- `get_status` returns `dead` for a killed tmux pane
- `get_status` returns `idle` or `busy` for a live pane with mock Claude
- `get_status` for self returns registration info

**Persistence:**
- State files are written to `/tmp/cc-tmux/state/`
- After server restart simulation, state is recovered from files
- Dead agents are detected and cleaned up on state reload

**And** all tests clean up their tmux sessions after completion
**And** the test suite can run in CI (requires tmux installed)
