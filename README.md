# cc-tmux

A Claude Code plugin that turns your terminal into an AI development team. Multiple Claude Code agents work in parallel, coordinated through tmux rooms.

## How it works

1. Start Claude Code sessions in tmux panes (as you normally would)
2. Register each agent into a room: `/cc-tmux:join-room myproject --role worker --name builder-1`
3. Your own CC session is the boss — give natural language direction
4. Leaders coordinate workers, workers execute tasks, everyone communicates through rooms

## Architecture

- **Boss** (your session) → manages leaders in the company room
- **Leaders** → manage workers in project rooms
- **Workers** → execute tasks, report status

Communication: push messages (tmux send-keys for commands) + pull messages (server-side queue for status updates).

## Requirements

- tmux 3.0+
- Bun runtime
- Claude Code with plugin support

## Installation (local dev)

```bash
claude --plugin-dir ./cc-tmux
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `join_room` | Register in a room with role + name |
| `leave_room` | Leave a room |
| `list_rooms` | List active rooms |
| `list_members` | List room members |
| `send_message` | Send push/pull message |
| `read_messages` | Read inbox messages |
| `get_status` | Check agent status |

## Skills

- `/cc-tmux:join-room` — Register your agent
- `/cc-tmux:leader` — Leader coordination patterns
- `/cc-tmux:worker` — Worker task handling patterns
- `/cc-tmux:boss` — Boss management patterns

## Status

Architecture complete. Implementation pending. See `docs/architecture.md` for details.
