---
name: crew:join-room
description: Register your AI coding agent in a crew room with a role
arguments: <room> --role <boss|leader|worker> --name <your-name>
---

# Join Room

Register yourself in a crew coordination room.

## Instructions

1. Parse arguments: `<room> --role <role> --name <name>`
2. Run via Bash:
   ```
   crew join --room <room> --role <role> --name <name>
   ```
3. Tmux pane auto-detected from `$TMUX_PANE`

**On success:** Confirm registration and pane ID.

**On error:** Show error message and stop.

## 4. Wait for Tasks

You are now registered as **{role}** in room **{room}**. Stay idle and wait for messages — tasks will be pushed to your pane automatically.

- **Boss/Leader:** Wait for the human to send you objectives or directives
- **Worker:** Wait for your leader to assign tasks

Do NOT start polling or reading messages proactively. Your role skill (`crew:boss`, `crew:leader`, or `crew:worker`) will be activated when the human or your manager sends you your first task.
