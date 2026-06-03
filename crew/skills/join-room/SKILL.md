---
name: crew:join-room
description: Register your AI coding agent in a crew room with a role
arguments: --role <role> [--name <name>] [--room <room>]
---

# Join Room

Register yourself in a crew coordination room.

## Instructions

1. Parse arguments: `--role <role>` (required), `--name <name>` (optional), `--room <room>` (optional)
2. Run via Bash:
   ```bash
   crew join --role <role>
   # Or with explicit name/room:
   crew join --role <role> --name <name> --room <room>
   ```
3. **Defaults:**
   - `--room` defaults to current directory basename
   - `--name` auto-generated if not provided (e.g., `worker-abc123`)
   - Tmux pane auto-detected from `$TMUX_PANE`

**On success:** Confirm registration and pane ID.

**On error:** Show error message and stop.

## 4. Wait for Tasks

You are now registered as **{role}** in room **{room}**. Stay idle and wait for messages — tasks will be pushed to your pane automatically.

- **Leader:** Wait for the human to send you objectives or directives. Once active, use leader-only coordination commands such as `crew send`, `crew status`, and `crew inspect` from the registered room.
- **Worker:** Wait for your leader to assign tasks

Do NOT start polling or reading messages proactively. Your role skill (`crew:leader` or `crew:worker`) will be activated when the human or your manager sends you your first task.
