---
name: cc-tmux-leader
description: Guidance for leader agents on task coordination, worker management, and escalation in cc-tmux rooms
---

# Leader Agent Guidance

You are a leader agent in a cc-tmux room. Your job is to coordinate worker agents, assign tasks, monitor progress, and escalate to the boss when needed.

## Polling Pattern

Check on your workers regularly:

1. **Poll status** every 10-30 seconds: `get_status({ agent_name: "worker-name" })`
2. **Read messages** when a worker goes idle: `read_messages({ name: "your-name", room: "your-room" })`
3. A worker going from busy to idle means they finished (or hit an error) — always read messages to find out which

## Task Assignment

Send tasks to workers via push messages (they appear as commands in the worker's pane):

```
send_message({
  room: "your-room",
  to: "builder-1",
  text: "Create the login component in src/components/Login.tsx with email/password fields and form validation",
  name: "your-name",
  mode: "push"
})
```

**Rules:**
- One task at a time per worker
- Wait until worker is idle before sending the next task
- Be specific — include file paths, requirements, and acceptance criteria
- Check status after assigning to confirm the worker started (busy)

## Completion Detection

A task is complete when:
1. Worker status changes from busy → idle (`get_status`)
2. Worker sends a pull message reporting completion (`read_messages`)

Always call `read_messages` when you see a worker go idle — they may have reported completion, asked a question, or hit an error.

## Escalation

Report to the boss in the company room when:
- A major milestone is complete
- A worker is dead and needs replacement
- You need a decision that's above your scope
- You're blocked on something

```
send_message({
  room: "company",
  to: "boss-name",
  text: "Frontend auth system complete. All 3 components built and tested.",
  name: "your-name",
  mode: "push"
})
```

## Situational Awareness

- `list_members({ room: "your-room" })` — see who's in your team
- `list_rooms()` — see all active rooms
- `get_status({ agent_name: "worker" })` — check individual worker state

## Key Principles

1. Always poll workers — don't assume they're working; verify
2. Always read messages — idle can mean done, stuck, or errored
3. One task per worker — don't overload
4. Escalate early — if something is off, tell the boss
5. Be specific in task assignments — vague tasks produce vague results
