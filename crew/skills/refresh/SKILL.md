---
name: refresh
description: Re-register your agent with current tmux pane after resuming a session
arguments: --name <your-name>
---

# Refresh

Re-register your crew agent without leaving and rejoining rooms. Use this after resuming a session.

## Usage

```
refresh --name <name>
```

**Example:**
```
refresh --name builder-1
```

## What This Does

1. Calls the `refresh` MCP tool with your name
2. Your tmux pane is auto-detected from `$TMUX_PANE`
3. Updates your pane registration in the database — all room memberships are preserved
4. If your agent was registered under the old JSON state, it migrates you to SQLite automatically

## When To Use

- After resuming a suspended session
- After your session reconnects
- When the dashboard doesn't show you but you know you registered before
- Any time your tmux pane ID changed but you want to keep your rooms

## Instructions

Parse the user's arguments and call the `refresh` tool:

```
Arguments: --name <name>

Call: refresh({ name: "<name>" })
```

On success, confirm: "Refreshed <name> — rooms: <rooms>, pane: <target>"

On error, show the error message. If agent not found, suggest using `join-room` instead.
