# Agent Crew

Multi-agent coordination for AI coding agents. Turn your terminal into an AI development team — multiple agents work in parallel, coordinated through tmux rooms. Works with **Claude Code** and **OpenAI Codex CLI**.

**GitHub:** [https://github.com/huypl53/agent-crew](https://github.com/huypl53/agent-crew)

## Quick Start

```bash
git clone https://github.com/huypl53/agent-crew.git ~/.crew
cd ~/.crew/crew && bun install && bun link

# Install plugin for Claude Code
claude plugins marketplace add ~/.crew
claude plugins install crew@crew-plugins
```

## What It Does

1. Start AI coding agent sessions in tmux panes
2. Register each agent into a room: `/crew:join-room myproject --role worker --name builder-1`
3. Your own session is the boss — give natural language direction
4. Leaders coordinate workers, workers execute tasks, everyone communicates through rooms
5. Browser dashboard at `crew serve` for real-time monitoring

## Architecture

```
Boss (you) → Leaders → Workers
                ↑
          tmux rooms (SQLite state)
```

- **Boss** — your session, manages leaders
- **Leader** — coordinates workers, assigns tasks, tracks progress
- **Worker** — executes tasks, reports status

Communication: push via tmux `paste-buffer` (bracketed paste) + pull via server-side queue.

## Plugins

- **[crew](./crew/)** — Room-based coordination for AI coding agents via tmux

## Documentation

Full docs in **[crew/README.md](./crew/README.md)** — CLI reference, delivery system, polling control, sweep, MCP tools, dashboard, token tracking.

## Browser Dashboard

```bash
crew serve                        # http://127.0.0.1:3456
crew serve --port 4000 --host 0.0.0.0
```

3-column React SPA: rooms sidebar, message feed with live WebSocket, agent inspector.
