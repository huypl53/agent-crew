---
name: refresh
description: Re-register your agent with current tmux pane after resuming a session
arguments: --name <your-name>
---

# Refresh

Re-register without leaving rooms. Use after session resume.

## When To Use

- Session resumed/reconnected
- Dashboard doesn't show you but you registered before
- Tmux pane ID changed but you want to keep room memberships

## Instructions

1. Parse arguments: `--name <name>`
2. Run via Bash:
   ```
   crew refresh --name <name>
   ```
3. Tmux pane auto-detected from `$TMUX_PANE`

**On success:** Confirm refresh with rooms list and pane ID.

**On error:** If agent not found, suggest `crew:join-room` instead.
