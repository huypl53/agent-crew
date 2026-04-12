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

Parse the user's arguments and run via Bash:

```
Arguments: <room> --role <role> --name <name>

Run: crew join --room <room> --role <role> --name <name>
```

Your tmux pane is auto-detected from `$TMUX_PANE`.

On success, confirm: "Registered as <name> (<role>) in room <room>. Tmux pane: <target>"

On error, show the error message from the command output.

## After Joining

You MUST immediately activate the behavior skill matching the role:
- **Boss:** Invoke the `crew:boss` skill — you manage leaders, never write code
- **Leader:** Invoke the `crew:leader` skill — you coordinate workers, never write code
- **Worker:** Invoke the `crew:worker` skill — you execute tasks and report status

Follow that skill's work loop for the remainder of the conversation.
