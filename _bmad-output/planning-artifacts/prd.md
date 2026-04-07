---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
classification:
  projectType: developer_tool
  domain: general
  complexity: medium
  projectContext: greenfield
inputDocuments:
  - '_bmad-output/brainstorming/brainstorming-session-2026-04-05-1500.md'
  - 'docs/mcp.md'
  - 'docs/channel.md'
  - 'docs/hooks.md'
  - 'docs/plugins.md'
workflowType: 'prd'
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 1
  projectDocs: 4
  projectContext: 0
---

# Product Requirements Document - cc-tmux

**Author:** lee
**Date:** 2026-04-05
**Classification:** Developer Tool | General Domain | Medium Complexity | Greenfield

## Executive Summary

cc-tmux is a Claude Code plugin that turns a developer's terminal into an AI development team. Multiple Claude Code agents self-register into tmux-based rooms, discover each other, and coordinate work through structured messaging — all without deploying servers, configuring APIs, or leaving the terminal.

The product targets senior developers and tech leads running complex projects who want to parallelize AI-assisted development: one agent on frontend, one on backend, one on tests, with a leader agent coordinating and the human steering through their own Claude Code session as the boss. The hierarchy (boss → leaders → workers) maps directly to how real engineering teams operate, except the "team" is AI agents and the "office" is tmux panes.

cc-tmux solves the fundamental limitation that Claude Code agents today are silos. Subagents are ephemeral and limited. For real parallel development across a codebase, you need persistent agents with coordination, and that coordination shouldn't require infrastructure beyond what's already on the developer's machine.

### What Makes This Special

**Zero infrastructure.** tmux is the communication bus, MCP is the tool interface, skills are the agent training mechanism. Everything runs locally using tools developers already have. No servers, no APIs, no dashboards.

**The human IS the boss agent.** The human's own Claude Code session is the top of the hierarchy. They give natural language direction to their boss agent, which translates into strategic coordination across leaders and workers. No separate monitoring tool — the human stays in their terminal, in their flow.

**The platform is ready.** Claude Code's plugin ecosystem (MCP + Skills + Plugins) has reached the maturity needed to build this as a plugin, not a separate product. Someone just needs to wire the pieces together.

## Success Criteria

### User Success

- A solo developer can set up a multi-agent "team" (boss + leader + 2-3 workers) in under 5 minutes using only tmux and the cc-tmux plugin
- Workers execute tasks in parallel on different parts of a codebase while the leader coordinates without human intervention
- The human steers the entire operation through natural language in their boss session — no context-switching to dashboards, TUIs, or config files
- Push messages arrive in worker panes and are acted on without manual intervention
- Agents discover each other via rooms without hardcoded addresses or manual wiring

### Business Success

- Open-source adoption: 500+ GitHub stars within 3 months of public release
- Active usage: 50+ developers using cc-tmux weekly within 6 months
- Community signal: Issues and PRs from external contributors within 3 months
- Plugin marketplace listing accepted

### Technical Success

- MCP server starts and responds to tool calls within 1 second
- Push message delivery (send_message → tmux send-keys → visible in target pane) under 500ms
- Server handles 20 concurrent registered agents without degradation
- State persists across server restarts — agents re-register, unread messages survive
- Integration tests pass with real tmux sessions and mock Claude agents

### Measurable Outcomes

- **Time-to-first-room:** Under 2 minutes from plugin install to first agent registered in a room
- **Message reliability:** 100% of push messages delivered to live panes, 100% of pull messages retrievable from queue
- **Recovery:** Server restart + state reload + agent re-adoption completes in under 5 seconds

## Product Scope

### MVP (Phase 1)

**MVP Approach:** Problem-solving MVP — deliver the minimum that makes multi-agent coordination work through rooms. A solo developer should be able to set up boss + leader + workers, send tasks, and see results within 5 minutes of install.

**Resource Requirements:** Solo developer project.

**Core User Journeys Supported:**
- Journey 1 (setup + parallel work) — fully supported
- Journey 2 (error escalation) — fully supported
- Journey 3 (debugging coordination) — partially supported (manual investigation via list_members + read_messages)

**Must-Have Capabilities:**

1. **Registration:** `join_room`, `leave_room` — agents self-register with role and name
2. **Discovery:** `list_rooms`, `list_members` — find rooms and agents
3. **Messaging:** `send_message` (push + pull modes), `read_messages` (cursor-based)
4. **Status:** `get_status` — idle/busy/dead detection via tmux capture-pane
5. **Delivery:** tmux `send-keys -l` push delivery with `[name@room]` convention header
6. **State:** File-backed JSON persistence in `/tmp/cc-tmux/state/`
7. **Skills:** join-room (slash command), leader, worker, boss (agent guidance)
8. **Validation:** tmux startup check, pane liveness validation on registration
9. **Testing:** Integration test suite with mock Claude (bash echo script)
10. **Packaging:** `.claude-plugin/`, `.mcp.json`, skills directory

**Absolute minimum viable (if time-constrained):** `join_room`, `send_message`, `read_messages` + leader skill. Three tools that prove the concept.

### Growth (Phase 2)

- `spawn_agent` / `kill_agent` — automated agent creation via tmux
- Permission bypass configuration for spawned workers
- pipe-pane logging for spawned agent output capture
- Enhanced CC status line regex library (idle/busy/error detection beyond basic)
- Message TTL and auto-pruning for inbox management
- Multi-leader support with conflict detection
- Broadcast message delivery optimization

### Vision (Phase 3)

- Human-in-the-loop via Telegram (boss escalates to human outside terminal)
- TUI observation dashboard (read-only room/agent monitoring)
- Agent templates (pre-configured role profiles: "frontend-dev", "test-writer", etc.)
- Cross-machine coordination (agents on different hosts via network transport)
- Plugin marketplace distribution
- Session recording and replay for debugging

## User Journeys

### Journey 1: Alex, Senior Full-Stack Dev — "The One-Person Team"

Alex is a senior developer at a startup, sole owner of a complex monorepo with a React frontend, Go backend, and Postgres migrations. They're already a tmux power user running 6+ panes daily. They've been using Claude Code but are frustrated — they can only talk to one agent at a time, and context-switching between "fix the API" and "write the tests" kills their flow.

**Opening Scene:** Alex installs cc-tmux via `--plugin-dir`. They open four tmux panes. In the first, they start Claude Code and type `/cc-tmux:join-room alpha --role boss --name alex`. In the other three, they start Claude Code sessions and register each as a worker: `frontend-1`, `backend-1`, `tester-1`. In a fifth pane, they register a leader: `lead-1`.

**Rising Action:** Alex tells their boss agent: "I need to add OAuth2 login. Frontend needs a login page, backend needs the auth middleware, and we need integration tests." The boss sends direction to lead-1 in the alpha room. lead-1 breaks this into tasks and pushes commands to each worker. Alex watches tmux panes light up — three agents working in parallel on different parts of the codebase.

**Climax:** lead-1 polls worker status, reads their output, detects that backend-1 is idle with a completion message. lead-1 reads the output, confirms the middleware is done, then tells tester-1: "backend auth middleware is complete, write integration tests against it." Meanwhile frontend-1 is still building the login page. Three agents, coordinated, zero human intervention.

**Resolution:** In 20 minutes, Alex has a working OAuth2 implementation across the full stack with tests — work that would have taken them half a day doing one agent at a time. They review the diffs in their boss session: "show me what everyone did." The boss queries each worker's room and summarizes.

### Journey 2: Alex — Edge Case — "The Worker Goes Sideways"

**Opening Scene:** Same setup. Alex has three workers running. backend-1 is implementing a database migration.

**Rising Action:** backend-1 hits a problem — the migration conflicts with an existing index. The CC agent in that pane outputs an error and goes idle. lead-1 polls status, sees backend-1 is idle, reads the output, and finds an error message instead of a completion report.

**Climax:** lead-1 sends a pull message to Alex's boss session: "backend-1 is stuck on a migration conflict, needs human decision." Alex reads their messages, sees the escalation, and tells their boss: "tell backend-1 to drop the old index and recreate it." The boss relays to lead-1, lead-1 pushes the instruction to backend-1.

**Resolution:** backend-1 resumes, completes the migration. The error was caught, escalated, and resolved through the room hierarchy — no manual pane-switching by Alex. The system degraded gracefully: worker hit a wall, leader detected it, boss escalated to human, human decided, instruction flowed back down.

### Journey 3: Alex — Debugging a Coordination Issue — "Where Did That Message Go?"

**Opening Scene:** Alex notices frontend-1 isn't doing anything. It's been idle for 5 minutes but lead-1 should have assigned it a task.

**Rising Action:** Alex uses their boss session to investigate: `list_members` on the alpha room — frontend-1 is registered and status shows `idle`. Alex checks `read_messages` — there are no unread messages for frontend-1. The issue: lead-1 sent a push message, but frontend-1 was mid-output when it arrived and the message got buried in scrollback.

**Climax:** Alex tells their boss: "resend the last task to frontend-1." Boss relays to lead-1, which resends the push message. This time frontend-1 is idle and picks it up. Alex makes a mental note — the leader skill should check that workers acknowledge task receipt.

**Resolution:** Alex adjusts lead-1's approach by sending it an instruction: "After sending a task to a worker, wait 30 seconds and check if they started. If still idle, resend." The leader adapts its polling pattern. The system self-corrects through the human's natural language steering.

### Journey Requirements Summary

| Capability | Revealed By |
|---|---|
| Room registration (`join_room`) | Journey 1 — setup phase |
| Push message delivery (`send_message`) | Journey 1 — leader commanding workers |
| Status polling (`get_status`) | Journey 1, 2 — leader detecting idle/completion |
| Pull messages (`read_messages`) | Journey 2 — escalation to boss |
| Member discovery (`list_members`) | Journey 3 — debugging |
| Message reliability / redelivery | Journey 3 — missed push messages |
| Boss-to-leader-to-worker hierarchy | Journey 2 — error escalation flow |
| Leader skill guidance | All journeys — leader polling and coordination patterns |
| Worker skill guidance | Journey 1 — workers acting on push messages |
| Boss skill guidance | Journey 2, 3 — human steering and investigation |

## Innovation & Novel Patterns

### Detected Innovation Areas

**New paradigm: tmux as an agent coordination bus.** No existing tool uses tmux sessions as the communication substrate for AI agent orchestration. Existing multi-agent systems require dedicated servers, custom protocols, or cloud infrastructure. cc-tmux inverts this by using a tool developers already run — tmux — as the entire transport layer.

**Self-registration model.** Most multi-agent frameworks use top-down orchestration (a controller spawns and manages agents). cc-tmux's room-based self-registration model treats agents as autonomous entities that choose to join a coordination group. This mirrors how real teams form — people join projects, they aren't spawned by managers.

**Skills as agent training.** Using Claude Code's skill system to teach agents their roles (boss/leader/worker behavior patterns) is a novel application of the plugin ecosystem. The "protocol" isn't code — it's natural language guidance that shapes agent behavior.

**The human as boss agent.** Collapsing the human-in-the-loop into the same hierarchy as the AI agents — not as an external monitor, but as the top of the command chain using the same tool (Claude Code) — is a unique interaction design.

### Market Context & Competitive Landscape

- **Claude Code subagents:** Built-in but ephemeral, no persistence, no parallel coordination across codebases
- **Custom MCP orchestration:** Requires building bespoke servers and protocols from scratch
- **LangGraph / CrewAI / AutoGen:** Python-based multi-agent frameworks that require separate infrastructure, not integrated into the developer's terminal workflow
- **tmux-based dev tools:** Exist for session management (tmuxinator, tmuxp) but none use tmux as an IPC mechanism for AI agents

cc-tmux occupies a unique niche: native Claude Code integration, zero-infrastructure, terminal-native, tmux-powered.

### Validation Approach

1. **Proof of concept:** Can two CC agents in separate tmux panes exchange messages via the MCP server and act on them? (Validates core transport)
2. **Leader-worker loop:** Can a leader agent assign a task to a worker, detect completion, and assign the next task without human intervention? (Validates coordination)
3. **Boss escalation:** Can a worker error trigger an escalation chain (worker → leader → boss → human) through room messaging? (Validates hierarchy)
4. **Parallel speedup:** Does running 3 workers on independent tasks complete faster than sequential single-agent work? (Validates the value proposition)

## Developer Tool Specific Requirements

### Project-Type Overview

cc-tmux is a Claude Code plugin (MCP server + skills) distributed as a local directory loaded via `--plugin-dir`. It runs as a Bun subprocess spawned by Claude Code, communicating over stdio via the MCP protocol. The plugin exposes 7 MCP tools and 4 skills.

### Language & Runtime

- **Implementation language:** TypeScript
- **Runtime:** Bun (native TS execution, no build step)
- **Target platform:** Linux, macOS (anywhere tmux + Claude Code runs)
- **Node.js compatibility:** Bun-only for v1

### Installation Methods

- **Primary:** `claude --plugin-dir ./cc-tmux` (local development)
- **Future:** Claude Code plugin marketplace
- **Dependencies:** `@modelcontextprotocol/sdk`, `strip-ansi`
- **System requirements:** tmux installed and available on PATH, Bun runtime

### API Surface (MCP Tools)

| Tool | Purpose | Key Params |
|---|---|---|
| `join_room` | Register agent in room | `room`, `role`, `name` |
| `leave_room` | Deregister from room | `room` |
| `list_rooms` | Show all active rooms | none |
| `list_members` | Show agents in a room | `room` |
| `send_message` | Send push or pull message | `room`, `to?`, `text`, `mode?` |
| `read_messages` | Read inbox messages | `room?`, `since_sequence?` |
| `get_status` | Query agent status | `agent_name?`, `room?` |

Optional (post-MVP): `spawn_agent`, `kill_agent`

### Plugin Structure

```
cc-tmux/
├── .claude-plugin/plugin.json
├── skills/{join-room,leader,worker,boss}/SKILL.md
├── .mcp.json
├── src/
│   ├── index.ts
│   ├── tools/{join-room,leave-room,list-rooms,list-members,send-message,read-messages,get-status}.ts
│   ├── tmux/index.ts
│   ├── state/index.ts
│   └── delivery/index.ts
├── test/
└── package.json
```

### Documentation Requirements

- README with quickstart (install, join a room, send a message)
- Skill documentation embedded in SKILL.md files (self-documenting)
- Architecture doc for contributors
- Example: "Set up a 3-agent team in 5 minutes" walkthrough

### Implementation Considerations

- **MCP SDK version:** Track latest `@modelcontextprotocol/sdk` compatible with current Claude Code
- **tmux version compatibility:** Test against tmux 3.0+ (modern send-keys -l support)
- **State directory:** `/tmp/cc-tmux/state/` — must handle concurrent access from multiple tool calls
- **ANSI stripping:** Apply via `strip-ansi` before returning any tmux capture output
- **Startup validation:** Check `tmux -V` on server init, fail fast with actionable error

## Functional Requirements

### Agent Registration & Rooms

- FR1: An agent can register itself in a named room with a role (boss, leader, or worker) and a unique name
- FR2: An agent can deregister itself from a room
- FR3: An agent can be a member of multiple rooms simultaneously
- FR4: The system can auto-detect the agent's tmux session and pane from environment variables during registration
- FR5: The system can reject registration if the agent is not running inside a tmux pane
- FR6: The system can reject registration if the agent name is already taken within the target room
- FR7: An agent can override auto-detected tmux target with an explicit parameter

### Discovery

- FR8: An agent can list all active rooms with member counts and role breakdown
- FR9: An agent can list all members of a specific room with their names, roles, and current status
- FR10: An agent can query the status of any registered agent (idle, busy, dead, unknown)

### Messaging — Push Delivery

- FR11: An agent can send a directed push message to a specific agent in a room, delivered as text input to the target's tmux pane
- FR12: An agent can send a broadcast push message to all members of a room
- FR13: Push messages are delivered with a convention header identifying the sender and room (`[name@room]: text`)
- FR14: The system can report whether push delivery succeeded (target pane alive) or failed (target pane dead)

### Messaging — Pull Delivery

- FR15: An agent can send a pull-mode message that is queued server-side without tmux delivery
- FR16: An agent can read messages from its inbox with cursor-based incremental retrieval
- FR17: An agent can filter inbox messages by room
- FR18: All messages (push and pull) are stored in the server-side inbox queue regardless of delivery mode

### Status Detection

- FR19: The system can detect whether a registered agent's tmux pane is alive or dead
- FR20: The system can detect whether a Claude Code agent is idle or busy by inspecting the tmux pane content
- FR21: Status detection occurs on-demand when queried, not via background polling

### State Persistence

- FR22: The system can persist room definitions, agent registrations, and message queues to disk
- FR23: The system can restore state from disk on server restart
- FR24: The system can validate registered agent pane liveness on state reload and mark dead agents

### Server Lifecycle

- FR25: The system can validate that tmux is installed and available at startup
- FR26: The system can fail fast with a clear error message if tmux is not found
- FR27: The system can accept MCP tool calls from any Claude Code session that has the plugin configured

### Skills & Agent Guidance

- FR28: A user can invoke a slash command to register their agent in a room (`/cc-tmux:join-room`)
- FR29: A leader agent can access guidance on polling patterns, task assignment, and completion detection
- FR30: A worker agent can access guidance on recognizing push message commands and reporting status
- FR31: A boss agent can access guidance on managing leaders, handling escalations, and organizational awareness

### Input Handling

- FR32: The system can deliver multi-line text messages via tmux without corruption
- FR33: The system can deliver messages containing special characters (semicolons, quotes, brackets) without corruption
- FR34: The system can strip ANSI escape codes from tmux capture output before returning to agents

## Non-Functional Requirements

### Performance

- NFR1: MCP tool calls must respond within 1 second under normal operation (≤20 registered agents)
- NFR2: Push message delivery (tool call → tmux send-keys → visible in target pane) must complete within 500ms
- NFR3: `read_messages` with up to 100 queued messages must respond within 200ms
- NFR4: State flush to disk must not block tool call processing
- NFR5: Server startup (including tmux validation and state reload) must complete within 5 seconds

### Reliability

- NFR6: All messages must be persisted to the server-side queue before returning success to the caller
- NFR7: Server restart must recover rooms, agent registrations, and unread messages from disk
- NFR8: Dead agent detection must correctly identify panes that no longer exist (zero false negatives on dead panes)
- NFR9: Push delivery failure (dead pane) must not cause message loss — message remains in queue for pull retrieval
- NFR10: Concurrent tool calls from multiple agents must not corrupt shared state

### Integration

- NFR11: MCP server must conform to the MCP protocol specification compatible with current Claude Code (v2.1+)
- NFR12: Plugin structure must conform to Claude Code plugin specification (`.claude-plugin/plugin.json`, skills in `skills/`, MCP config in `.mcp.json`)
- NFR13: tmux wrapper must support tmux 3.0 and later
- NFR14: Must run on Linux and macOS (platforms where both tmux and Claude Code are available)

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| CC status line format changes across versions | Regex detection is empirically calibrated, first implementation task. Fallback: poll-only detection. |
| Push messages lost when agent is busy | All messages stored in server-side queue. Push is optimistic; pull is the reliable fallback. |
| tmux send-keys unreliable for complex input | Always use literal mode (`-l`), send Enter separately. Multi-line confirmed working via paste detection. |
| Plugin ecosystem changes break packaging | Track CC plugin spec closely. Simple structure (manifest + skills + MCP) unlikely to break. |
| CC status line parsing — riskiest technical component | First implementation task with fallback to poll-only detection. |
| Concurrent state access from parallel tool calls | Synchronous state operations in Bun's single-threaded event loop. |
| Solo developer resource constraint | Absolute minimum: 3 tools (`join_room`, `send_message`, `read_messages`) + leader skill. |
| Adoption depends on tmux + CC users | This is the target audience. Validate by shipping and measuring. |

## Open Questions for Implementation

1. **CC status line regexes:** Must be calibrated empirically. First implementation task. Capture what CC actually shows in idle, busy, starting, and error states.
2. **Permission bypass flag:** Verify exact CC CLI flag or `settings.json` key for auto-accept on spawned agents (Phase 2).
3. **State flush frequency:** Every write? Every N seconds? On shutdown only? Decide during implementation.
4. **Message retention:** How long are read messages kept? Immediate discard after read? TTL? Decide during implementation.
5. **join-room as skill vs command:** Verify whether a Claude Code plugin skill can invoke an MCP tool directly, or if the slash command needs to be a `commands/` markdown file that instructs the agent to call the MCP tool.
