# cc-tmux Session Report

**Date:** 2026-04-05
**Duration:** ~3 hours
**Method:** Monitor agent proxied user with BMad brainstorming agent via tmux, then ran UAT

---

## What is cc-tmux?

A Claude Code plugin that turns your terminal into an AI development team. You start multiple Claude Code sessions in tmux panes, register them into "rooms" with roles, and they coordinate autonomously.

```mermaid
graph TB
    subgraph "Your Terminal (tmux)"
        Human["You (typing)"]
        Boss["Boss Agent<br/><i>your CC session</i>"]
        
        subgraph "Company Room"
            Boss
            L1["Leader: frontend"]
            L2["Leader: backend"]
        end
        
        subgraph "Project: frontend"
            L1
            W1["Worker: ui-builder"]
            W2["Worker: test-writer"]
        end
        
        subgraph "Project: backend"
            L2
            W3["Worker: api-dev"]
            W4["Worker: db-migration"]
        end
    end
    
    Human -->|natural language| Boss
    Boss -->|strategic direction| L1
    Boss -->|strategic direction| L2
    L1 -->|task assignment| W1
    L1 -->|task assignment| W2
    L2 -->|task assignment| W3
    L2 -->|task assignment| W4
    W1 -.->|status update| L1
    W3 -.->|escalation| L2
    L2 -.->|escalation| Boss
```

**Key insight:** The human's own Claude Code session IS the boss. No dashboards, no separate monitoring tools. You stay in your terminal, in your flow.

---

## How It Works

```mermaid
sequenceDiagram
    participant H as Human
    participant B as Boss (CC)
    participant L as Leader (CC)
    participant W as Worker (CC)
    participant S as MCP Server
    
    Note over H,W: Setup Phase
    H->>B: /cc-tmux:join-room company --role boss --name ceo
    B->>S: join_room(room=company, role=boss, name=ceo)
    S-->>B: Registered ✓
    
    H->>L: /cc-tmux:join-room company --role leader --name frontend-lead
    L->>S: join_room(room=company, role=leader, name=frontend-lead)
    
    H->>W: /cc-tmux:join-room frontend --role worker --name builder-1
    W->>S: join_room(room=frontend, role=worker, name=builder-1)
    
    Note over H,W: Work Phase
    H->>B: "Build the auth system"
    B->>S: send_message(room=company, to=frontend-lead, text="Build auth system")
    S->>L: tmux send-keys → [ceo@company]: Build auth system
    
    L->>S: send_message(room=frontend, to=builder-1, text="Create login component")
    S->>W: tmux send-keys → [frontend-lead@frontend]: Create login component
    
    Note over W: Worker executes task...
    
    W->>S: send_message(room=frontend, to=frontend-lead, text="done", mode=pull)
    L->>S: read_messages()
    S-->>L: [{from: builder-1, text: "done"}]
    
    L->>S: send_message(room=company, to=ceo, text="Auth complete", mode=pull)
    B->>S: read_messages()
    S-->>B: [{from: frontend-lead, text: "Auth complete"}]
    B->>H: "Auth system is complete"
```

---

## Architecture

```mermaid
graph LR
    subgraph "Claude Code Plugin"
        direction TB
        Skills["Skills<br/>join-room / leader / worker / boss"]
        MCP["MCP Server<br/><i>bun run src/index.ts</i>"]
    end
    
    subgraph "MCP Server Internals"
        direction TB
        Tools["src/tools/<br/>7 tool handlers"]
        State["src/state/<br/>rooms, agents, inboxes"]
        Delivery["src/delivery/<br/>push + pull logic"]
        Tmux["src/tmux/<br/>send-keys, capture-pane"]
        Disk["JSON files<br/>/tmp/cc-tmux/state/"]
    end
    
    subgraph "tmux"
        P1["%100 — Worker pane"]
        P2["%101 — Leader pane"]
        P3["%102 — Boss pane"]
    end
    
    Skills --> MCP
    MCP --> Tools
    Tools --> State
    Tools --> Delivery
    Delivery --> Tmux
    Delivery --> State
    State --> Disk
    Tmux --> P1
    Tmux --> P2
    Tmux --> P3
```

### Dual-Mode Messaging

The system has two delivery modes to solve the interrupt-vs-poll tradeoff:

```mermaid
graph TD
    Agent["Agent calls send_message()"]
    Queue["Always: write to target's inbox queue"]
    Mode{"mode?"}
    Push["PUSH: tmux send-keys<br/>[name@room]: text<br/>→ appears as user input"]
    Pull["PULL: queue only<br/>target reads via read_messages()"]
    
    Agent --> Queue
    Queue --> Mode
    Mode -->|"push (default for commands)"| Push
    Mode -->|"pull (for status updates)"| Pull
```

| Mode | When to use | Delivery | Example |
|------|-------------|----------|---------|
| **Push** | Commands, urgent tasks | tmux send-keys + queue | Leader assigns task to worker |
| **Pull** | Status updates, non-urgent | Queue only | Worker reports "task complete" |

---

## MCP Tool API (7 tools)

```mermaid
graph TD
    subgraph "Registration"
        JR[join_room] -->|"room, role, name"| REG["Agent registered in room"]
        LR[leave_room] -->|"room"| DEREG["Agent removed from room"]
    end
    
    subgraph "Discovery"
        LRO[list_rooms] -->|"no params"| ROOMS["All rooms + member counts"]
        LM[list_members] -->|"room"| MEMBERS["All agents in room"]
    end
    
    subgraph "Communication"
        SM[send_message] -->|"room, to?, text, mode?"| MSG["Message queued + delivered"]
        RM[read_messages] -->|"room?, since?"| INBOX["Messages from inbox"]
    end
    
    subgraph "Status"
        GS[get_status] -->|"agent_name?"| STATUS["idle / busy / dead / unknown"]
    end
```

| Tool | Params | Returns |
|------|--------|---------|
| `join_room` | `room`, `role` (boss/leader/worker), `name` | `{ agent_id, name, role, room, tmux_target }` |
| `leave_room` | `room` | `{ success: true }` |
| `list_rooms` | — | `{ rooms: [{ name, member_count, roles }] }` |
| `list_members` | `room` | `{ room, members: [{ name, role, status }] }` |
| `send_message` | `room`, `to?`, `text`, `mode?` | `{ message_id, delivered, queued }` |
| `read_messages` | `room?`, `since_sequence?` | `{ messages: [...], next_sequence }` |
| `get_status` | `agent_name?` | `{ name, role, status, last_activity_ts }` |

---

## Design Decisions

### Why tmux?

- Already on every developer's machine
- Survives SSH disconnects (agents keep working)
- `send-keys` = inject input, `capture-pane` = read output
- Zero infrastructure — no servers, APIs, or databases

### Why rooms instead of direct spawn?

```mermaid
graph LR
    subgraph "Rejected: Spawn-Control"
        Leader2["Leader"] -->|spawns| W5["Worker"]
        Leader2 -->|spawns| W6["Worker"]
        Leader2 -->|controls lifecycle| W5
    end
    
    subgraph "Adopted: Register-Discover"
        Human2["Human starts CC agents"] --> A1["Agent"]
        Human2 --> A2["Agent"]
        Human2 --> A3["Agent"]
        A1 -->|"/cc-tmux:join-room"| Room["Room"]
        A2 -->|"/cc-tmux:join-room"| Room
        A3 -->|"/cc-tmux:join-room"| Room
    end
```

**Register-Discover wins because:**
- Human controls which agents exist (security boundary)
- Agents are autonomous participants, not spawned processes
- Rooms map to real team structure (project teams, company leadership)
- Spawn preserved as optional Phase 2 feature

### How status detection works

```mermaid
stateDiagram-v2
    [*] --> CapturePane: get_status called
    CapturePane --> CheckDead: tmux list-panes -F '#{pane_dead}'
    CheckDead --> DEAD: pane is dead
    CheckDead --> ParseStatus: pane alive
    ParseStatus --> BUSY: spinner pattern found<br/>(· Contemplating… (3s))
    ParseStatus --> IDLE: empty ❯ prompt found
    ParseStatus --> UNKNOWN: no pattern matched
    
    DEAD --> [*]
    BUSY --> [*]
    IDLE --> [*]
    UNKNOWN --> [*]
```

Regex patterns (empirically validated via UAT):

| State | Pattern | Example |
|-------|---------|---------|
| **Idle** | `^❯\s*$` | `❯` (empty prompt) |
| **Busy** | `/^[·*✶✽✻]\s+\w+…\s+\(\d/` | `· Contemplating… (3s)` |
| **Complete** | `/^✻\s+\w+\s+for\s+/` | `✻ Baked for 1m 2s` |
| **Dead** | `#{pane_dead}` via tmux | pane no longer exists |

---

## Project Structure

```
cc-tmux/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── skills/
│   ├── join-room/SKILL.md       # /cc-tmux:join-room slash command
│   ├── leader/SKILL.md          # Leader coordination patterns
│   ├── worker/SKILL.md          # Worker task handling
│   └── boss/SKILL.md            # Boss management patterns
├── .mcp.json                    # bun run src/index.ts
├── src/
│   ├── index.ts                 # MCP server entrypoint
│   ├── tools/                   # One file per tool (7 files)
│   ├── tmux/index.ts            # send-keys, capture-pane wrapper
│   ├── state/index.ts           # Rooms, agents, inboxes (file-backed)
│   └── delivery/index.ts        # Push + pull delivery logic
├── test/
│   ├── mock-claude.sh           # Bash script simulating CC
│   └── helpers.ts               # tmux test session management
└── package.json                 # bun + @modelcontextprotocol/sdk + strip-ansi
```

---

## Implementation Plan

### Epic Dependency Flow

```mermaid
graph LR
    E1["Epic 1<br/>Foundation<br/><i>2 stories</i>"]
    E2["Epic 2<br/>Registration<br/><i>5 stories</i>"]
    E3["Epic 3<br/>Messaging<br/><i>5 stories</i>"]
    E4["Epic 4<br/>Status Detection<br/><i>2 stories</i>"]
    E5["Epic 5<br/>Persistence<br/><i>2 stories</i>"]
    E6["Epic 6<br/>Skills<br/><i>4 stories</i>"]
    E7["Epic 7<br/>Integration Tests<br/><i>2 stories</i>"]
    
    E1 --> E2
    E2 --> E3
    E2 --> E4
    E3 --> E5
    E4 --> E5
    E5 --> E6
    E6 --> E7
```

### Epic Summary

| Epic | Stories | FRs | What it delivers |
|------|---------|-----|-----------------|
| **1. Foundation** | 2 | FR25-27 | Plugin scaffold, MCP server, tmux validation |
| **2. Registration** | 5 | FR1-9 | join/leave rooms, list rooms/members, state module |
| **3. Messaging** | 5 | FR11-18,32,33 | Push/pull messages, broadcast, inbox, tmux wrapper |
| **4. Status** | 2 | FR10,19-21,34 | Idle/busy/dead detection, ANSI stripping |
| **5. Persistence** | 2 | FR22-24 | JSON state files, restart recovery, liveness validation |
| **6. Skills** | 4 | FR28-31 | join-room command, leader/worker/boss guidance |
| **7. Testing** | 2 | All | Mock Claude, integration test suite |
| **Total** | **22** | **34/34** | **Full MVP** |

---

## UAT Results (5/5 PASS)

All tests ran against a real Claude Code Opus 4.6 agent in tmux.

```mermaid
pie title UAT Test Results
    "PASS" : 5
    "FAIL" : 0
```

| # | Test | Result | What was validated |
|---|------|--------|--------------------|
| 1 | CC Status Line Regex | PASS | Idle/busy/dead detection patterns documented |
| 2 | send-keys Literal Mode | PASS | Special chars (`; " [ ] { } & \| #`) delivered correctly |
| 3 | Multi-line Paste | PASS | 3-line text held in input, submitted on Enter |
| 4 | Push Message Format | PASS | `[leader-1@myproject]: ...` received + executed by CC |
| 5 | TMUX Env Vars | PASS | `$TMUX` and `$TMUX_PANE` readable from CC agent |

**End-to-end validated:** Monitor agent sent `[leader-1@myproject]: create file /tmp/cc-tmux-test.txt` → Worker CC agent received it → Created the file → File verified on disk.

---

## Deliverables Produced

| Artifact | Path | Size |
|----------|------|------|
| Brainstorming | `_bmad-output/brainstorming/brainstorming-session-2026-04-05-1500.md` | 15.8 KB |
| PRD | `_bmad-output/planning-artifacts/prd.md` | 23.8 KB |
| Architecture | `_bmad-output/planning-artifacts/architecture.md` | 27.1 KB |
| Epics & Stories | `_bmad-output/planning-artifacts/epics.md` | 30.3 KB |
| UAT Results | `_bmad-output/test-artifacts/uat-tmux-primitives.md` | 5.2 KB |
| This Report | `_bmad-output/session-report.md` | — |
| README | `README.md` | — |
| Architecture Summary | `docs/architecture.md` | — |

---

## Open Items for Implementation

1. **CC status line regexes** — Patterns documented, but may need tuning across CC versions
2. **Permission bypass flag** — Workers need auto-accept; verify exact CLI flag or `settings.json` key
3. **State flush frequency** — Write-through (every mutation) vs batched; decide during Epic 5
4. **Message retention** — Immediate discard after read? TTL? Decide during Epic 3
5. **join-room skill mechanism** — Verify if a plugin skill can directly invoke an MCP tool

---

## What's Next

The project is **architecture-complete and UAT-validated**. Ready for implementation starting with Epic 1 (project scaffold + MCP server).

```mermaid
graph LR
    DONE["✅ Brainstorming"]
    DONE2["✅ PRD"]
    DONE3["✅ Architecture"]
    DONE4["✅ Epics"]
    DONE5["✅ UAT"]
    NEXT["→ Epic 1<br/>Implementation"]
    
    DONE --> DONE2 --> DONE3 --> DONE4 --> DONE5 --> NEXT
```
