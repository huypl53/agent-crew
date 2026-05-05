import type { ServerWebSocket } from 'bun';
import {
  getAllAgents,
  getAllMessages,
  getAllRooms,
  getChangeVersions,
  searchTasks,
} from '../state/index.ts';
import { capturePane } from '../tmux/index.ts';
import { getPaneStatus } from '../shared/pane-status.ts';

const POLL_SCOPES = [
  'messages',
  'agents',
  'tasks',
  'rooms',
  'templates',
  'room-templates',
];

const MIRROR_MAX_CHARS = 6000;

function trimToMaxChars(input: string, maxChars = MIRROR_MAX_CHARS): string {
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars);
}

async function broadcastPaneMirrors(): Promise<void> {
  const agents = getAllAgents().filter((a) => a.tmux_target);
  await Promise.all(
    agents.map(async (agent) => {
      const paneTarget = agent.tmux_target;
      if (!paneTarget) return;
      try {
        const [text, statusResult] = await Promise.all([
          capturePane(paneTarget),
          getPaneStatus(paneTarget),
        ]);
        if (text === null) return;
        broadcast({
          type: 'pane-mirror',
          room: agent.room_name,
          agent: agent.name,
          pane: paneTarget,
          status: statusResult.status,
          typing_active: statusResult.typingActive,
          input_chars: statusResult.inputChars,
          content: trimToMaxChars(text),
          captured_at: new Date().toISOString(),
        });
      } catch {
        // swallow per-agent mirror failure; do not impact other WS events
      }
    }),
  );
}

const clients = new Set<ServerWebSocket<unknown>>();
let lastVersions: Record<string, number> = {};
let pollTimer: ReturnType<typeof setInterval> | null = null;
let isBroadcastCycleInFlight = false;

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

async function broadcastChanges(): Promise<void> {
  if (clients.size === 0) return;
  const versions = getChangeVersions(POLL_SCOPES);
  await broadcastPaneMirrors();

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
  pollTimer = setInterval(() => {
    if (isBroadcastCycleInFlight) return;
    isBroadcastCycleInFlight = true;
    void broadcastChanges()
      .catch(() => {
        // Swallow poll-cycle failures to keep timer alive.
      })
      .finally(() => {
        isBroadcastCycleInFlight = false;
      });
  }, 500);
}

export function stopWsPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isBroadcastCycleInFlight = false;
}
