---
name: join-room
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

**On success:** Confirm registration and pane ID, then proceed to step 4.

**On error:** Show error message and stop.

## 4. Activate Role Behavior (REQUIRED)

Immediately invoke the skill matching your role:

| Role | Skill | Behavior |
|------|-------|----------|
| boss | `crew:boss` | Manage leaders, never write code |
| leader | `crew:leader` | Coordinate workers, never write code |
| worker | `crew:worker` | Execute tasks, report status |

Use the Skill tool to invoke. Follow that skill's work loop for the remainder of the session.
