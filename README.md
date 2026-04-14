# Agent Crew Marketplace

Plugin marketplace for AI agent coordination tools.

## Plugins

- **[crew](./crew/)** — Room-based coordination for AI coding agents via tmux

## Installation

```bash
claude plugins marketplace add <path-to-this-repo>
claude plugins install crew@crew-plugins
```

## Browser Dashboard

A web UI for monitoring and managing rooms, agents, tasks, and messages in real time.

**Build the frontend** (one-time, or after frontend changes):

```bash
cd crew/src/web && bun install
cd crew && bun run build:web   # outputs to crew/dist/web/
```

**Start the server:**

```bash
crew serve                        # http://127.0.0.1:3456
crew serve --port 4000            # custom port
crew serve --host 0.0.0.0         # bind all interfaces (LAN access)
```

The dashboard serves a 3-column Vite/React/Tailwind SPA:
- **Rooms sidebar** — browse rooms, create/delete rooms
- **Message feed** — threaded message history with live WebSocket updates, composer
- **Agent inspector** — view and edit agent persona/capabilities

REST API available at `/api/*`. WebSocket live updates at `/ws`.
