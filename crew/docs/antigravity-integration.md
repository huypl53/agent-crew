# Antigravity (agy) Integration Guide

This guide outlines how the Antigravity CLI (`agy`) integrates with `agent-crew` to support AI agent room coordination, worker session inspection, and event hook forwarding.

---

## 1. Lifecycle Hooks Integration

Antigravity executes custom hooks configured in the customization directory (e.g., `.agents/hooks.json` in the workspace or `~/.gemini/config/hooks.json` globally).

Unlike Claude Code, Antigravity does not use matcher-wrapped blocks. The hook events must be defined directly in the event name's array within a wrapper block (e.g., `"crew-hooks"`).

### Event Mappings
- **`PreInvocation`**: Fired before a tool or prompt invocation. In `crew`, this acts as the prompt submission trigger to auto-unblock the agent.
- **`Stop`**: Fired when `agy` completes a turn or terminates. In `crew`, this acts as the worker completion trigger to write and forward the last message.

### Configuration (`hooks.json` schema)
```json
{
  "crew-hooks": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "crew hook-event --event PreInvocation || true",
        "shell": "bash"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "crew hook-event --event Stop || true",
        "shell": "bash"
      }
    ]
  }
}
```

---

## 2. Dynamic Database Routing (`cwd` resolution)

Since the `crew hook-event` command is invoked as a background shell process by the `agy` runtime, the active working directory (CWD) of the hook process might not be the project root (it may start in the user home or system temp directories).

To prevent the hook process from connecting to a temporary global database (like `/tmp/crew/state/crew.db`), `crew` resolves the project database dynamically:

1. **Payload Extraction**: The hook payload sent to stdin contains `workspacePaths` (an array of workspace paths).
2. **CWD Resolution**: The CLI extracts the first path from `workspacePaths` as the `cwd`.
3. **Connection Realignment**: If the currently active database path (e.g. default `/tmp/crew/state/crew.db`) does not match the project's target database path (e.g. `/path/to/project/.agents/state/crew.db`), the connection is automatically closed and re-opened to point to the correct project database.

This logic is implemented in [hook-event.ts](file:///home/vtit/code/utils/agent-crew/crew/src/tools/hook-event.ts) and ensures the hook correctly resolves the registered agent and room members.

---

## 3. Brain Logs and Transcript Inspection

When a leader inspects a worker's session, `crew` reads the session's active transcript from the Antigravity `brain` directory.

### Paths
The transcript logs are stored as `.jsonl` files in the user's home directory. `crew` queries the following paths in order of precedence:
- **CLI Application**: `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
- **Desktop Application**: `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`

### Transcript Schema
Antigravity's JSONL transcript schema differs from Claude Code. It features:
- `source`: `"MODEL"`, `"USER_EXPLICIT"`, or `"SYSTEM"`.
- `type`: `"PLANNER_RESPONSE"` (assistant turn) or `"USER_INPUT"` (user turn).
- `content`: String content of the model prompt or response.

`crew` parses these entries using the `extractRecentAgyTurns` utility to reconstruct the worker's recent thoughts and progress.

---

## 4. Setup and Installation

### Global Scope
Installs the plugin globally to be shared by all workspaces:
```bash
./install.sh --agy
```
This clones the repository into `~/.crew`, links the binary, and symlinks the plugin manifest and skills into `~/.gemini/config/plugins/huypl53.crew`.

### Project Scope
Configures local skills and appends the hook configuration to `.agents/hooks.json` in the specified workspace root:
```bash
./install.sh --agy-project [path_to_workspace]
```

### Uninstallation
```bash
# Global cleanup
./install.sh --uninstall-agy

# Project cleanup
./install.sh --uninstall-agy-project [path_to_workspace]
```

---

## 5. Troubleshooting

### "Agent not found for pane %XYZ session ... event Stop"
If you see this in the hook debug log (`/tmp/crew-hook-debug.log`), it means:
1. The agent is not registered in the database for that room. Run `crew join-room` on the worker pane.
2. The database path resolved by the hook differs from the one used during registration. Ensure that the workspace path is correctly parsed by checking the `cwd` parameter logged in `/tmp/crew-hook-debug.log`.
