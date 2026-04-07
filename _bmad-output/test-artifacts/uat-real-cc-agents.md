# UAT: Real Claude Code Agents — Calendar Project

**Date**: 2026-04-06
**Environment**: 3 Claude Code v2.1.92 sessions (Sonnet 4.6), calendar project, installer-deployed config
**Install method**: `install.sh` user scope + `install.sh --project`

## Summary

Full end-to-end UAT with real CC agents coordinating on a real codebase (calendar app). All 7 MCP tools verified. Multi-process state sync fixed and validated.

| Test | Status | Notes |
|------|--------|-------|
| Agent registration (3 agents, 2 rooms) | PASS | Boss, leader, worker all registered via `/cc-tmux-join-room` skill |
| Multi-room join (leader in 2 rooms) | PASS | `lead-fe` in company + frontend |
| Cross-process state visibility | PASS | Boss sees all rooms/members from other processes via `syncFromDisk` |
| Push messaging boss→leader | PASS | `[ceo@company]: Build the auth module...` delivered to leader pane |
| Pull messaging leader→boss | PASS | Acknowledgment queued, boss read via `read_messages` |
| Push messaging leader→worker (task delegation) | PASS | 5-step specific task with file paths sent to worker pane |
| Worker receives and processes task | PASS | Worker explored codebase, started implementing |
| Status detection (busy) | PASS | Leader checked `get_status(builder-1)` → "busy" |
| State persistence | PASS | 3 agents, 2 rooms, 3 messages in `/tmp/cc-tmux/state/` |
| Installer (user scope) | PASS | Skills in `~/.claude/skills/`, MCP in `~/.claude.json` |
| Installer (project scope) | PASS | Skills in `.claude/skills/`, MCP in `.mcp.json` |

## Multi-Process Bug Found & Fixed

**Bug**: Each CC session spawns its own MCP server process (stdio transport). The original `flushState()` did a blind overwrite of `/tmp/cc-tmux/state/*.json`, causing processes to clobber each other's registrations.

**Fix**: 
1. `flushAsync()` now does read-merge-write: reads disk state, merges with in-memory, then writes
2. Added `syncFromDisk()` — called before any read operation (list_rooms, list_members, send_message, read_messages, get_status) to pick up other processes' changes
3. `clearState()` disables disk sync (for unit tests) and removes disk files

## Real Communication Flow

```
Boss (ceo@company) ──push──→ Leader (lead-fe@company)
  "Build the auth module for the calendar app.
   Requirements: OAuth2 with Google Calendar API."

Leader (lead-fe@company) ──pull──→ Boss (ceo)
  "Acknowledged. Breaking down OAuth2/Google Calendar
   auth module task now. Will assign to frontend workers."

Leader autonomously:
  1. Called list_members(frontend) to find workers
  2. Read the calendar codebase (auth config, env, routes)
  3. Found existing better-auth + GitHub OAuth pattern

Leader (lead-fe@frontend) ──push──→ Worker (builder-1@frontend)
  5-step task: env-schema.ts, auth/config.ts, routes/index.ts,
  pages/login.tsx, auth-client.ts

Worker autonomously:
  1. Received push message as user input
  2. Explored codebase structure
  3. Started implementing (detected as "busy" by get_status)

Boss reads inbox:
  1 message from lead-fe: "Acknowledged..."
```

## Agent Behavior Observations

- **Boss**: Called `list_rooms` and `read_messages` correctly, rendered nice tables
- **Leader**: Showed autonomous coordination — received task, acknowledged, explored codebase, broke down into specific file-level tasks, delegated to worker, then waited
- **Worker**: Followed the skill guidance — watched for `[name@room]:` pattern, treated it as a task command, started executing
- **Status detection**: `get_status(builder-1)` correctly detected "busy" from CC's thinking animation (`✻ Hyperspacing…`)

## Installer Verification

Both install scopes tested and working:
- User scope: `~/.claude.json` mcpServers merged (preserved existing gitnexus entry)
- Project scope: `.mcp.json` + `.claude/skills/cc-tmux-*/` created in calendar project
- CC loaded MCP server and skills from both scopes
- Uninstall removes cleanly (empty `.mcp.json` deleted automatically)
