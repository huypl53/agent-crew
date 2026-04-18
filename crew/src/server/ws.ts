import type { ServerWebSocket } from 'bun';
import {
  getAllAgents,
  getAllMessages,
  getAllRooms,
  getChangeVersions,
  getTasksForAgent,
  searchTasks,
} from '../state/index.ts';

const POLL_SCOPES = [
  'messages',
  'agents',
  'tasks',
  'rooms',
  'templates',
  'room-templates',
];

const clients = new Set<ServerWebSocket<unknown>>();
let lastVersions: Record<string, number> = {};
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function wsOpen(ws: ServerWebSocket<unknown>): void {
  clients.add(ws);
}

export function wsClose(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
}

function broadcast(event: unknown): void {
  const json = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {
      clients.delete(ws);
    }
  }
}

function broadcastChanges(): void {
  if (clients.size === 0) return;
  const versions = getChangeVersions(POLL_SCOPES);

  for (const scope of POLL_SCOPES) {
    const current = versions[scope]?.version ?? 0;
    const prev = lastVersions[scope] ?? 0;
    if (current <= prev) continue;

    if (scope === 'messages') {
      const msgs = getAllMessages();
      for (const msg of msgs) {
        broadcast({ type: 'message', room: msg.room, message: msg });
      }
    } else if (scope === 'agents') {
      for (const agent of getAllAgents()) {
        broadcast({
          type: 'agent-status',
          name: agent.name,
          status: 'unknown',
        });
      }
    } else if (scope === 'tasks') {
      const tasks = searchTasks({});
      for (const task of tasks) {
        broadcast({
          type: 'task-update',
          taskId: task.id,
          status: task.status,
        });
      }
    } else if (scope === 'rooms') {
      for (const room of getAllRooms()) {
        broadcast({
          type: 'room-change',
          room: room.name,
          kind: 'topic-changed',
        });
      }
    } else if (scope === 'templates') {
      broadcast({ type: 'template-change' });
    } else if (scope === 'room-templates') {
      broadcast({ type: 'room-template-change' });
    }
    lastVersions[scope] = current;
  }
}

export function startWsPoller(): void {
  if (pollTimer) return;
  // Snapshot current versions so first poll only broadcasts genuinely new changes
  lastVersions = {};
  const snap = getChangeVersions(POLL_SCOPES);
  for (const scope of POLL_SCOPES) {
    lastVersions[scope] = snap[scope]?.version ?? 0;
  }
  pollTimer = setInterval(broadcastChanges, 500);
}

export function stopWsPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
