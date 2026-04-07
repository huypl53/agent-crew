---
name: join-room
description: Register your AI coding agent in a cc-tmux room with a role
arguments: <room> --role <boss|leader|worker> --name <your-name>
---

# Join Room

Register yourself in a cc-tmux coordination room.

## Usage

```
join-room <room> --role <role> --name <name>
```

**Example:**
```
join-room frontend --role worker --name builder-1
```

## What This Does

1. Calls the `join_room` MCP tool with your room, role, and name
2. Your tmux pane is auto-detected from `$TMUX_PANE`
3. On success, you're registered and other agents can discover you via `list_rooms` / `list_members`

## After Joining

Based on your role, follow these coordination patterns:

**Boss:** Monitor the company room for leader reports. Use `list_rooms` + `list_members` for situational awareness. Send strategic direction via push messages to leaders.

**Leader:** Poll workers with `get_status` every 10-30s. Assign tasks via push to workers. Read completion reports via `read_messages`. Escalate to boss in the company room.

**Worker:** Watch for `[name@room]:` push messages from your leader — these are task commands. Report completion via `send_message(mode: "pull")`. Ask for help via pull messages to your leader.

## Instructions

Parse the user's arguments and call the `join_room` tool:

```
Arguments: <room> --role <role> --name <name>

Call: join_room({ room: "<room>", role: "<role>", name: "<name>" })
```

On success, confirm: "Registered as <name> (<role>) in room <room>. Tmux pane: <target>"

On error, show the error message from the tool response.
