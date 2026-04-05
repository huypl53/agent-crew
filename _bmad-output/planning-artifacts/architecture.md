---
stepsCompleted: ['step-01-init', 'step-02-context', 'step-03-starter', 'step-04-decisions', 'step-05-patterns', 'step-06-structure', 'step-07-validation', 'step-08-complete']
status: 'complete'
completedAt: '2026-04-05'
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-04-05-1500.md'
  - 'docs/mcp.md'
  - 'docs/channel.md'
  - 'docs/hooks.md'
  - 'docs/plugins.md'
workflowType: 'architecture'
project_name: 'cc-tmux'
user_name: 'lee'
date: '2026-04-05'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
34 FRs organized across 8 capability areas:
- **Agent Registration & Rooms (FR1-FR7):** Self-registration with role/name, multi-room membership, tmux auto-detection, duplicate name rejection
- **Discovery (FR8-FR10):** Room listing with role breakdown, member listing with status, on-demand agent status query
- **Push Messaging (FR11-FR14):** Directed and broadcast push delivery via tmux send-keys, convention header format, delivery success reporting
- **Pull Messaging (FR15-FR18):** Server-side queue with cursor-based reads, room filtering, all messages always queued regardless of mode
- **Status Detection (FR19-FR21):** Pane liveness via `#{pane_dead}`, CC idle/busy regex detection, on-demand only (no polling)
- **State Persistence (FR22-FR24):** File-backed JSON, state reload on restart, pane liveness validation on reload
- **Server Lifecycle (FR25-FR27):** tmux startup validation, fail-fast errors, accept MCP calls from any configured session
- **Skills & Input Handling (FR28-FR34):** 4 skills (join-room, leader, worker, boss), multi-line delivery, special char handling, ANSI stripping

**Non-Functional Requirements:**
14 NFRs driving architecture:
- **Performance (NFR1-5):** Tool calls <1s, push delivery <500ms, read_messages <200ms for 100 msgs, non-blocking state flush, startup <5s
- **Reliability (NFR6-10):** Messages persisted before success response, state survives restart, zero false negatives on dead detection, push failure doesn't lose messages, concurrent access safety
- **Integration (NFR11-14):** MCP protocol conformance, Claude Code plugin spec conformance, tmux 3.0+ support, Linux + macOS

**Scale & Complexity:**
- Primary domain: Developer tool / CLI plugin
- Complexity level: Medium — MCP server with tmux IPC and file-backed state
- Estimated architectural components: 4 modules (tools, tmux, state, delivery) + 4 skills

### Technical Constraints & Dependencies

- **Runtime:** Bun (native TypeScript, no build step)
- **Protocol:** MCP over stdio (spawned as subprocess by Claude Code)
- **Transport:** tmux send-keys for push, server-side queue for pull
- **State:** File-backed JSON in `/tmp/cc-tmux/state/`
- **Dependencies:** `@modelcontextprotocol/sdk`, `strip-ansi` only
- **Platform:** Linux + macOS (tmux + Claude Code availability)
- **Concurrency:** Bun's single-threaded event loop handles concurrent tool calls safely
- **No external services:** Everything runs locally, no network, no database, no auth

### Cross-Cutting Concerns Identified

- **ANSI stripping:** All tmux capture-pane output must be stripped before returning to agents (affects status detection and any future output capture)
- **Tmux validation:** Every tool that interacts with tmux panes must handle dead/missing panes gracefully
- **Message durability:** All messages (push + pull) must be written to server-side queue before any delivery attempt
- **State consistency:** In-memory state must flush to disk periodically; concurrent tool calls must not corrupt state
- **CC status line parsing:** Shared regex logic used by `get_status` and optional spawn ready-detection — must be calibrated empirically

## Starter Template Evaluation

### Primary Technology Domain

MCP server plugin (CLI tool / developer infrastructure) — not a web app, mobile app, or API with a framework. No established starter templates exist for this domain.

### Starter Options Considered

| Option | Assessment |
|---|---|
| `create-mcp-server` (Anthropic) | Not available as a public CLI generator. MCP SDK provides library only, not a project scaffold. |
| Custom Bun project template | No Bun-specific MCP server template exists. |
| Generic TypeScript starter | Over-engineered for this project. Would need to strip more than it provides. |

### Selected Approach: From-Scratch Project

**Rationale:** The project is a focused MCP server with 4 internal modules. The tech stack is minimal (Bun + MCP SDK + strip-ansi). A starter template would add unnecessary complexity. The brainstorming doc already defines the exact project structure.

**Initialization Command:**
```bash
mkdir cc-tmux && cd cc-tmux && bun init
bun add @modelcontextprotocol/sdk strip-ansi
```

**Architectural Decisions (established, not from starter):**

**Language & Runtime:**
- TypeScript with Bun's native TS execution (no tsc build step)
- Bun runtime for all execution

**Build Tooling:**
- No build step — Bun runs TS directly
- `bun run src/index.ts` as the MCP server entry point

**Testing Framework:**
- Bun's built-in test runner (`bun test`)
- Integration tests with real tmux sessions and mock Claude (bash echo script)

**Code Organization:**
- Modular by responsibility: `tools/`, `tmux/`, `state/`, `delivery/`
- One file per MCP tool in `tools/`
- Skills as markdown files in `skills/`

**Development Experience:**
- `bun --watch src/index.ts` for development
- No linting/formatting tools specified for v1 (add if needed)

**Note:** Project initialization is the first implementation task.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- MCP tool API surface (7 core tools)
- Dual-mode messaging (push + pull)
- Room-based registration model
- File-backed state persistence
- tmux as delivery transport

**Important Decisions (Shape Architecture):**
- Agent identity model (user-provided name, unique per room)
- Status detection approach (on-demand capture-pane regex)
- Push message convention (`[name@room]: text`)
- Skills-based protocol (convention in skills, not enforced by server)

**Deferred Decisions (Post-MVP):**
- `spawn_agent` / `kill_agent` (Phase 2)
- Message TTL and auto-pruning
- Multi-leader conflict detection
- Permission bypass configuration for spawned workers

### Data Architecture

**State Model:** In-memory primary, file-backed JSON persistence
- `agents.json` — Agent registry: `{ agent_id, name, role, rooms[], tmux_target, joined_at }`
- `rooms.json` — Room definitions: `{ name, members[], created_at }`
- `messages.json` — Per-agent inbox queues: `{ message_id, from, room, text, timestamp, sequence }`
- Location: `/tmp/cc-tmux/state/`
- Flush strategy: TBD during implementation (every write vs periodic vs shutdown)
- On restart: Reload from files, validate pane liveness, mark dead agents

**Data Validation:** At system boundaries only
- `join_room`: Validate tmux pane exists, name unique in room, role is valid enum
- `send_message`: Validate room exists, sender is member, target exists (if directed)
- No schema validation library — simple runtime checks

**No database.** No ORM. No migrations. JSON files are the entire persistence layer.

### Authentication & Security

**No authentication for v1.** Single-user trust model — any MCP client on the machine can call tools. The MCP server runs as a subprocess of Claude Code, inheriting the user's permissions.

**Security boundaries:**
- tmux pane access scoped to current user's tmux server
- State files in `/tmp/cc-tmux/state/` owned by current user
- No network listeners — MCP over stdio only

### API & Communication Patterns

**MCP Tool API (7 core tools):**

| Tool | Type | Key Behavior |
|---|---|---|
| `join_room` | Registration | Auto-detect tmux from `$TMUX`/`$TMUX_PANE`, register agent in room |
| `leave_room` | Registration | Deregister, discard unread messages for that room |
| `list_rooms` | Discovery | All rooms with member counts by role |
| `list_members` | Discovery | All agents in room with name, role, status |
| `send_message` | Messaging | Dual-mode: push (tmux send-keys) + pull (queue only). Always queues. |
| `read_messages` | Messaging | Cursor-based inbox read, optional room filter |
| `get_status` | Status | On-demand capture-pane regex for idle/busy/dead |

**Message Delivery:**
- **Push:** `tmux send-keys -l "[name@room]: text"` then `send-keys Enter`. Optimistic — may fail if target busy.
- **Pull:** Message written to server-side inbox only. Target reads via `read_messages`.
- **All messages always queued** in server-side inbox regardless of mode. Push is additive delivery on top.
- **Broadcast:** `to` omitted → message sent to all room members except sender.

**Error Handling:**
- Tool calls return structured JSON: `{ success: true, ...data }` or `{ success: false, error: "message" }`
- No error codes enum for v1 — human-readable error strings
- tmux failures (dead pane, missing session) return descriptive errors

### Infrastructure & Deployment

**Runtime:** Bun — native TypeScript execution, single binary, fast startup
**Distribution:** Claude Code plugin via `--plugin-dir ./cc-tmux`
**MCP Launch:** `.mcp.json` → `{ "mcpServers": { "cc-tmux": { "command": "bun", "args": ["run", "src/index.ts"] } } }`
**Configuration:** Environment variables only
- `CC_TMUX_PREFIX` — session prefix for spawned agents (default: `cc-`)
- `CC_TMUX_DEFAULT_MODEL` — default model for spawn (default: `claude-sonnet-4-6`)
- No config file for v1

**No CI/CD, no containers, no cloud.** Local development tool. `bun test` is the test runner.

### Decision Impact Analysis

**Implementation Sequence:**
1. Project init (bun init, deps, plugin manifest)
2. MCP server skeleton (index.ts with tool registration)
3. State module (in-memory + JSON persistence)
4. tmux module (send-keys, capture-pane, list-panes, validate)
5. Delivery module (push + pull logic)
6. Tools (join_room → leave_room → list_rooms → list_members → send_message → read_messages → get_status)
7. Skills (join-room → worker → leader → boss)
8. Integration tests

**Cross-Component Dependencies:**
- All tools depend on state module
- `send_message` depends on delivery module
- Delivery module depends on tmux module
- `get_status` depends on tmux module directly
- Skills are independent markdown files, no code dependencies

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**8 conflict areas** where AI agents could make different choices, all resolved below.

### Naming Patterns

**File Naming:**
- Tool files: `kebab-case.ts` — e.g., `join-room.ts`, `send-message.ts`, `get-status.ts`
- Module index files: `index.ts` in each module directory
- Skill files: `SKILL.md` (uppercase, Claude Code convention)
- Test files: `*.test.ts` co-located in `test/` directory

**Code Naming:**
- Functions: `camelCase` — e.g., `joinRoom()`, `sendMessage()`, `getStatus()`
- Types/Interfaces: `PascalCase` — e.g., `Agent`, `Room`, `Message`, `ToolResult`
- Constants: `UPPER_SNAKE_CASE` — e.g., `STATE_DIR`, `DEFAULT_MODEL`
- Variables: `camelCase` — e.g., `agentId`, `roomName`, `tmuxTarget`

**MCP Tool Naming:**
- Tool names: `snake_case` — e.g., `join_room`, `send_message`, `read_messages` (MCP convention)
- Tool parameter names: `snake_case` — e.g., `room`, `agent_name`, `since_sequence`

**JSON State File Keys:**
- `snake_case` — e.g., `agent_id`, `tmux_target`, `joined_at`, `member_count`

### Structure Patterns

**Project Organization:**
- One file per MCP tool in `src/tools/`
- One index file per internal module (`tmux/index.ts`, `state/index.ts`, `delivery/index.ts`)
- Skills as `skills/{skill-name}/SKILL.md`
- Tests in `test/` directory (not co-located with source)

**Module Boundaries:**
- `tools/` — MCP tool handlers only. Each tool imports from state/tmux/delivery as needed.
- `tmux/` — Pure tmux CLI wrapper. No business logic. Functions: `sendKeys()`, `capturePane()`, `listPanes()`, `validateTmux()`
- `state/` — In-memory state + JSON persistence. Functions: `getAgent()`, `addAgent()`, `removeAgent()`, `getRoom()`, `addMessage()`, `readMessages()`, `flush()`, `load()`
- `delivery/` — Push + pull delivery logic. Orchestrates tmux send-keys for push, writes to state queue for pull.

### Format Patterns

**MCP Tool Response Format:**
```typescript
// Success
{ content: [{ type: "text", text: JSON.stringify({ agent_id, name, role, room, tmux_target }) }] }

// Error
{ content: [{ type: "text", text: JSON.stringify({ error: "descriptive message" }) }], isError: true }
```
All tool responses are JSON-stringified text content per MCP protocol.

**Internal Data Formats:**
- Timestamps: ISO 8601 strings — `new Date().toISOString()`
- Message sequences: Monotonically increasing integers per agent inbox
- Agent IDs: Same as agent name (user-provided, unique per room)
- tmux targets: `{session}:{window}.{pane}` format from `$TMUX_PANE`

### Communication Patterns

**Push Message Format (in target's pane):**
```
[sender-name@room-name]: message text here
```
Single convention. No variations. No metadata envelope. Skills teach agents to parse this.

**tmux Command Patterns:**
- Send: `tmux send-keys -t {target} -l "{text}"` then `tmux send-keys -t {target} Enter`
- Capture: `tmux capture-pane -t {target} -p` (stdout)
- Validate: `tmux list-panes -t {target} -F '#{pane_dead}'`
- Version check: `tmux -V`

All tmux commands executed via `Bun.spawn()` (not `child_process`).

### Process Patterns

**Error Handling:**
- tmux command failures: Catch, return descriptive error in tool response. Never throw.
- State inconsistency: Log warning, attempt recovery (re-validate panes). Never crash.
- Missing pane on send: Queue message, return `delivered: false`. Never discard.

**State Flush Pattern:**
- Write-through: Flush to disk after every state mutation (safe default for v1)
- Async write: `Bun.write()` is async but state module awaits it before returning
- Startup: `load()` reads all JSON files, validates pane liveness, marks dead agents

**ANSI Stripping:**
- Apply `stripAnsi()` to all `capture-pane` output before any processing or return
- Single point of application: in the `tmux/index.ts` `capturePane()` function

### Enforcement Guidelines

**All AI Agents implementing cc-tmux MUST:**
- Use `snake_case` for MCP tool names and parameters
- Use `camelCase` for TypeScript functions and variables
- Return MCP-compliant JSON text responses from all tools
- Always queue messages to inbox before attempting push delivery
- Always use `send-keys -l` (literal mode) for tmux text delivery
- Always strip ANSI from capture-pane output in the tmux module
- Never throw exceptions from tool handlers — return error responses

## Project Structure & Boundaries

### Complete Project Directory Structure

```
cc-tmux/
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest (name, version, description)
├── skills/
│   ├── join-room/
│   │   └── SKILL.md                   # /cc-tmux:join-room — user-invoked registration
│   ├── leader/
│   │   └── SKILL.md                   # Leader agent guidance (polling, task assignment, escalation)
│   ├── worker/
│   │   └── SKILL.md                   # Worker agent guidance (recognize commands, report status)
│   └── boss/
│       └── SKILL.md                   # Boss agent guidance (manage leaders, strategic direction)
├── .mcp.json                          # MCP server config: "bun run src/index.ts"
├── src/
│   ├── index.ts                       # MCP server entrypoint — tool registration, stdio transport
│   ├── tools/
│   │   ├── join-room.ts               # join_room tool handler
│   │   ├── leave-room.ts              # leave_room tool handler
│   │   ├── list-rooms.ts              # list_rooms tool handler
│   │   ├── list-members.ts            # list_members tool handler
│   │   ├── send-message.ts            # send_message tool handler
│   │   ├── read-messages.ts           # read_messages tool handler
│   │   └── get-status.ts              # get_status tool handler
│   ├── tmux/
│   │   └── index.ts                   # tmux CLI wrapper: sendKeys, capturePane, listPanes, validateTmux
│   ├── state/
│   │   └── index.ts                   # In-memory state + JSON persistence: agents, rooms, messages
│   └── delivery/
│       └── index.ts                   # Push (tmux send-keys) + pull (queue) delivery orchestration
├── test/
│   ├── integration.test.ts            # Full integration: join, send, read, status with real tmux
│   ├── mock-claude.sh                 # Bash script simulating Claude Code (echo + status line)
│   └── helpers.ts                     # Test utilities: tmux session setup/teardown
├── package.json                       # Bun project: deps, scripts
├── tsconfig.json                      # TypeScript config (Bun defaults)
├── README.md                          # Quickstart, usage, examples
└── .gitignore
```

### Architectural Boundaries

**API Boundary (MCP Protocol):**
- `src/index.ts` is the only MCP protocol surface — registers tools, handles stdio transport
- Each tool in `src/tools/` exports a handler function called by `index.ts`
- Tools receive MCP-parsed params, return MCP-compliant responses
- No tool calls another tool directly

**Module Boundaries:**

```
┌─────────────────────────────────────────────┐
│  MCP Protocol Layer (src/index.ts)          │
│  - Tool registration                        │
│  - stdio transport                          │
│  - Param validation                         │
└──────────────┬──────────────────────────────┘
               │ calls
┌──────────────▼──────────────────────────────┐
│  Tool Handlers (src/tools/*.ts)             │
│  - Business logic per tool                  │
│  - Imports from state, tmux, delivery       │
└──┬───────────┬──────────────┬───────────────┘
   │           │              │
   ▼           ▼              ▼
┌──────┐  ┌────────┐  ┌──────────┐
│state/│  │delivery/│  │  tmux/   │
│      │  │        │  │          │
│agents│  │push()  │  │sendKeys()│
│rooms │  │pull()  │  │capture() │
│msgs  │  │        │  │validate()│
└──────┘  └───┬────┘  └──────────┘
              │ uses
              ▼
          ┌────────┐
          │  tmux/  │
          └────────┘
```

**Data Boundary:**
- `state/` owns all data. No other module reads/writes JSON files directly.
- `delivery/` writes messages via `state.addMessage()`, never directly to files
- `tmux/` has no state — pure function wrapper around CLI commands

**Skill Boundary:**
- Skills are pure markdown — no code execution
- Skills reference MCP tool names but don't import or call them
- Skills guide agent behavior through natural language conventions

### Requirements to Structure Mapping

**FR Category → Files:**

| FR Category | Primary Files |
|---|---|
| Registration (FR1-7) | `tools/join-room.ts`, `tools/leave-room.ts`, `state/index.ts`, `tmux/index.ts` |
| Discovery (FR8-10) | `tools/list-rooms.ts`, `tools/list-members.ts`, `tools/get-status.ts`, `state/index.ts` |
| Push Messaging (FR11-14) | `tools/send-message.ts`, `delivery/index.ts`, `tmux/index.ts` |
| Pull Messaging (FR15-18) | `tools/send-message.ts`, `tools/read-messages.ts`, `state/index.ts` |
| Status Detection (FR19-21) | `tools/get-status.ts`, `tmux/index.ts` |
| State Persistence (FR22-24) | `state/index.ts` |
| Server Lifecycle (FR25-27) | `src/index.ts`, `tmux/index.ts` |
| Skills (FR28-31) | `skills/join-room/SKILL.md`, `skills/leader/SKILL.md`, `skills/worker/SKILL.md`, `skills/boss/SKILL.md` |
| Input Handling (FR32-34) | `tmux/index.ts`, `delivery/index.ts` |

### Data Flow

```
Agent calls MCP tool
  → index.ts routes to tool handler
  → tool handler calls state/ for data operations
  → if send_message: tool calls delivery/
    → delivery/ calls state.addMessage() (always)
    → delivery/ calls tmux.sendKeys() (push mode only)
  → tool returns MCP response to agent
```

## Architecture Validation Results

### Coherence Validation

**Decision Compatibility:** All decisions align cleanly:
- Bun runtime + MCP SDK + strip-ansi = minimal, compatible dependency set
- File-backed JSON state + Bun's single-threaded event loop = no concurrency issues
- tmux send-keys push + server-side queue pull = complementary delivery modes
- Skills (markdown) + MCP tools (TypeScript) = clean separation, no circular dependencies

**Pattern Consistency:**
- `snake_case` for MCP-facing names (tools, params, JSON state) — matches MCP convention
- `camelCase` for TypeScript internals — matches TS convention
- `kebab-case` for files — matches Node/Bun convention
- No naming collisions between layers

**Structure Alignment:**
- 4 source modules map directly to 4 architectural responsibilities (tools, tmux, state, delivery)
- Module dependency graph is acyclic: tools → {state, delivery, tmux}, delivery → {state, tmux}
- Skills are isolated markdown — cannot create structural coupling

### Requirements Coverage Validation

**Functional Requirements Coverage:**
- FR1-7 (Registration): Fully covered by `join-room.ts`, `leave-room.ts`, `state/`, `tmux/` validation
- FR8-10 (Discovery): Fully covered by `list-rooms.ts`, `list-members.ts`, `get-status.ts`
- FR11-14 (Push): Fully covered by `send-message.ts` + `delivery/` + `tmux/sendKeys`
- FR15-18 (Pull): Fully covered by `send-message.ts` + `read-messages.ts` + `state/` queue
- FR19-21 (Status): Fully covered by `get-status.ts` + `tmux/capturePane`
- FR22-24 (Persistence): Fully covered by `state/` JSON flush + reload + liveness validation
- FR25-27 (Lifecycle): Fully covered by `index.ts` startup + `tmux/validateTmux`
- FR28-31 (Skills): Fully covered by 4 skill SKILL.md files
- FR32-34 (Input): Fully covered by `tmux/sendKeys` literal mode + `stripAnsi` in capturePane

**Non-Functional Requirements Coverage:**
- NFR1-5 (Performance): Bun's fast startup + in-memory state + async file I/O supports all perf targets
- NFR6-10 (Reliability): Write-through state flush + always-queue-first + dead pane detection covers reliability
- NFR11-14 (Integration): MCP SDK conformance + plugin manifest + tmux 3.0+ send-keys -l support

**Coverage: 34/34 FRs mapped, 14/14 NFRs addressed. No gaps.**

### Implementation Readiness Validation

**Decision Completeness:** All critical decisions documented with specific technology choices, no TBD items that block implementation. Two deferred-to-implementation items (state flush frequency, message retention) are implementation-time tuning, not architectural gaps.

**Structure Completeness:** Every file in the project tree has a defined purpose and maps to specific FRs. No placeholder directories.

**Pattern Completeness:** Naming, structure, format, communication, and process patterns all specified with concrete examples. Enforcement guidelines explicit.

### Gap Analysis Results

**No critical gaps.** Two implementation-time decisions noted:
1. State flush frequency (every write vs periodic) — defaulting to write-through for safety
2. Message retention after read (immediate discard vs TTL) — decide during implementation

**One open research item:**
- CC status line regexes must be calibrated empirically. First implementation task. Architecture is designed to accommodate any regex pattern without structural changes.

### Architecture Completeness Checklist

- [x] Project context thoroughly analyzed (34 FRs, 14 NFRs, 8 capability areas)
- [x] Scale and complexity assessed (medium, 4 modules + 4 skills)
- [x] Technical constraints identified (Bun, MCP stdio, tmux, local-only)
- [x] Cross-cutting concerns mapped (ANSI strip, tmux validation, message durability, state consistency, CC regex)
- [x] Critical decisions documented (7 tools, dual-mode messaging, room model, file state, tmux transport)
- [x] Technology stack fully specified (Bun + MCP SDK + strip-ansi)
- [x] Integration patterns defined (MCP protocol, tmux CLI, JSON persistence)
- [x] Naming conventions established (snake_case MCP, camelCase TS, kebab-case files)
- [x] Structure patterns defined (module boundaries, data ownership, skill isolation)
- [x] Communication patterns specified (push format, tmux commands, MCP responses)
- [x] Process patterns documented (error handling, state flush, ANSI stripping)
- [x] Complete directory structure defined (all files and directories)
- [x] Component boundaries established (API, module, data, skill)
- [x] Integration points mapped (tool→state, tool→delivery→tmux, tool→tmux)
- [x] Requirements to structure mapping complete (34 FRs → specific files)

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High — all decisions are concrete, no ambiguous abstractions, minimal dependency surface

**Key Strengths:**
- Extremely focused scope: 7 tools, 4 modules, 4 skills
- Clean dependency graph with no cycles
- Dual-mode messaging solves push reliability without complexity
- File-backed state is simple, debuggable, and sufficient for single-user local tool
- Skills-based protocol keeps the MCP server thin and the intelligence in the agents

**Areas for Future Enhancement:**
- spawn_agent / kill_agent (Phase 2)
- Message TTL and auto-pruning
- Enhanced CC status line regex library
- Multi-leader conflict detection

### Implementation Handoff

**AI Agent Guidelines:**
- Follow all architectural decisions exactly as documented
- Use implementation patterns consistently across all components
- Respect module boundaries — state/ owns data, tmux/ owns CLI, delivery/ owns message routing
- Refer to this document for all architectural questions

**First Implementation Priority:**
1. `bun init` + deps + `.claude-plugin/plugin.json` + `.mcp.json`
2. MCP server skeleton in `src/index.ts`
3. CC status line regex calibration (empirical research task)
