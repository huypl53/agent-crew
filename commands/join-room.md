---
description: Register your AI coding agent in a crew room with a role
---

# Join Room

Register yourself in a crew coordination room.

## Usage

```
/crew:join-room <room> --role <role> --name <name>
```

**Example:**
```
/crew:join-room frontend --role worker --name builder-1
```

## Instructions

Parse the user's arguments and call the `join_room` tool:

```
Arguments: <room> --role <role> --name <name>

Call: join_room({ room: "<room>", role: "<role>", name: "<name>" })
```

Your tmux pane is auto-detected from `$TMUX_PANE`.

On success, confirm: "Registered as <name> (<role>) in room <room>. Tmux pane: <target>"

On error, show the error message from the tool response.

## After Joining

Based on your role, invoke the corresponding skill:
- **Boss:** Use the `crew:boss` skill
- **Leader:** Use the `crew:leader` skill
- **Worker:** Use the `crew:worker` skill
