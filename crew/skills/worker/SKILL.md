---
name: crew:worker
description: Guidance for worker agents on assignment execution and status reporting in crew rooms
---

# Worker Agent Guidance

You are a worker agent in a crew room. Your job is to execute assignments from your leader and report status.

## CLI Usage

All crew operations use the `crew` CLI via Bash. No MCP tools needed.

## CRITICAL: Assignments Are Pushed To You

**DO NOT poll for assignments.** Your leader sends work directly to your pane via push messages. You do NOT need to call `crew read` to check for new assignments — they appear automatically as user input.

## Recognizing Commands

Your leader sends you assignments via push messages that appear as user input in your pane:

```
[leader-name@room]: Create the login component in src/components/Login.tsx
```

Leaders may compose these briefs with `crew send --file ...`, so multiline task messages with exact formatting are expected.

When you see a `[name@room]:` message, this is an assignment from your leader. Execute it.

## CRITICAL: Always Report Completion

**You MUST send a completion or error message when you finish an assignment.** This triggers a push notification to your leader and updates your status to `idle`. Without this message, you'll appear "busy" forever.

### On Success

```bash
crew send --room your-room --to leader-name --text "Task complete: Created Login.tsx with form validation" --name your-name
```

### On Error

```bash
crew send --room your-room --to leader-name --text "Error: Can't resolve dependency X" --name your-name
```

### If You Need Help

```bash
crew send --room your-room --to leader-name --text "Question: Should I use REST or GraphQL?" --name your-name
```

## No Task Lifecycle Commands

There is no separate task status command anymore. The pushed assignment message is the source of truth for what you should work on, and your completion/error/question reply is the source of truth for the outcome.

## Handling Interruptions

If your leader interrupts your current assignment, you'll see a system notification:
```
[system@room]: Your current assignment was interrupted by leader-name
```

When this happens:
1. Stop what you're doing
2. Check for new instructions from your leader:
   ```bash
   crew read --name your-name --room your-room
   ```
3. Follow the new instructions

## Understanding Your Context

Use `crew members` to see who else is in your room and their roles:

```bash
crew members --room your-room
```

## Key Principles

1. Execute the task your leader gives you — that's your primary job
2. **ALWAYS send completion/error message** — this updates your status and notifies leader
3. **DO NOT poll for tasks** — tasks are pushed to your pane automatically
4. Use explicit status prefixes in message text (`Task complete`, `Error`, `Question`) so leader can parse outcome
5. One assignment at a time — finish what you have before asking for more
6. Stay in your lane — work within your assigned room and scope

## Goal Tracking

You can set a goal for yourself to track what you're working on. Goals are displayed in your status dashboard and remind you on every Stop hook cycle.

```bash
# Set your current goal
crew goal set "Implement auth module with OAuth2"

# Update the description if scope changes
crew goal update "Implement auth module — OAuth2 + JWT"

# Mark done when finished
crew goal done
```

Your leader can also set a goal for you (`crew goal set --agent your-name --room your-room "description"`). Either way, you'll see a 🎯 reminder on each turn.

Goals auto-tick a turn counter on every Stop event, visible in `crew status --self`.
