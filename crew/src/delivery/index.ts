import type {
  ActiveEndpoint,
  Agent,
  MessageDeliveryMetadata,
} from '../shared/types.ts';
import { renderBatchFinalMessage } from '../state/batch-render.ts';
import { getDb } from '../state/db.ts';
import { resolveAgentRuntime } from '../shared/hook-runtime.ts';
import {
  addMessage,
  advancePushCursor,
  claimPushCursor,
  armLeaderGoalReminder,
  getAgent,
  getAgentByRoomAndName,
  getAgentInputBlockMode,
  getAllAgents,
  getMessageBatch,
  getPushCursor,
  getRenderableBatchWorkers,
  getRoom,
  getRoomMembers,
  getRoomReminderDispatchCount,
  incrementRoomReminderDispatchCount,
  markAgentStale,
  queueBatchFinalDelivery,
  recordBatchWorkerTerminalMessage,
  rollbackPushCursor,
} from '../state/index.ts';
import {
  markEndpointStale,
  resolveActiveEndpoint,
} from '../state/session-binding.ts';
import {
  capturePaneTail,
  paneCommandLooksAlive,
  paneExists,
} from '../tmux/index.ts';
import { getQueue, PaneDeliveryError } from './pane-queue.ts';

interface DeliveryResult {
  message_id: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
}

interface DeliveryContext {
  to: string;
  senderName: string;
  roomName: string;
  text: string;
  fullText: string;
  targetName: string | null;
  replyTo?: number | null;
  metadata?: MessageDeliveryMetadata;
  agent?: Agent;
}

function describeEndpoint(endpoint: ActiveEndpoint): string {
  return `${endpoint.transport}:${endpoint.target}`;
}

async function checkEndpointLiveness(
  agent: Agent,
  endpoint: ActiveEndpoint,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await paneExists(endpoint.target))) {
    markEndpointStale(agent);
    return {
      ok: false,
      error: `Agent endpoint ${describeEndpoint(endpoint)} no longer exists. Agent may need to rejoin.`,
    };
  }

  const agentRuntime = await resolveAgentRuntime(agent.agent_type, endpoint.target);
  if (agentRuntime === 'claude-code' || agentRuntime === 'codex') {
    if (!(await paneCommandLooksAlive(endpoint.target))) {
      markAgentStale(agent.name);
      return {
        ok: false,
        error: `stale-target: ${describeEndpoint(endpoint)} is not running an agent process`,
      };
    }
  }

  return { ok: true };
}

function shouldApplyReminder(
  roomName: string,
  targetAgent: Agent | undefined,
): boolean {
  const policy =
    targetAgent?.reminder_policy ?? getRoom(roomName)?.reminder_policy;
  if (!policy?.enabled) return false;
  if (policy.cadence_mode === 'always') return true;
  const cadenceN = Math.max(1, Math.floor(policy.cadence_n || 1));
  const dispatchCount = getRoomReminderDispatchCount(roomName);
  return (dispatchCount + 1) % cadenceN === 0;
}

function decorateMessageWithReminder(
  text: string,
  roomName: string,
  targetAgent: Agent | undefined,
): string {
  const policy =
    targetAgent?.reminder_policy ?? getRoom(roomName)?.reminder_policy;
  if (!policy?.enabled) return text;
  if (!shouldApplyReminder(roomName, targetAgent)) return text;
  const prefix = policy.prefix?.trim() ?? '';
  const suffix = policy.suffix?.trim() ?? '';
  if (!prefix && !suffix) return text;
  return [prefix, text, suffix].filter(Boolean).join(' ').trim();
}

function shouldArmLeaderGoalReminder(
  targetAgent: Agent | undefined,
  sender: Agent | undefined,
  metadata?: MessageDeliveryMetadata,
): boolean {
  if (!targetAgent || targetAgent.role !== 'leader') return false;
  if (metadata?.batch_id) return true;
  return sender?.role === 'worker';
}

async function deliverToTarget(ctx: DeliveryContext): Promise<DeliveryResult> {
  const { to, senderName, roomName, text, targetName, replyTo } = ctx;
  const targetAgent = ctx.agent ?? getAgent(to);
  const room = getRoom(roomName);
  const senderAgent = room
    ? (getAgentByRoomAndName(room.id, senderName) ?? getAgent(senderName))
    : getAgent(senderName);
  const outgoingText = decorateMessageWithReminder(text, roomName, targetAgent);
  const header = `[${senderName}@${roomName}]:`;
  const fullText = `${header} ${outgoingText}`;

  const msg = addMessage(
    to,
    senderName,
    roomName,
    outgoingText,
    targetName ?? to,
    replyTo,
    ctx.metadata,
  );

  const agent = ctx.agent ?? getAgent(to);
  if (!agent) {
    return {
      message_id: msg.message_id,
      delivered: false,
      queued: true,
      error: 'Agent not found',
    };
  }

  const endpoint = resolveActiveEndpoint(agent);
  if (!endpoint) {
    return {
      message_id: msg.message_id,
      delivered: false,
      queued: true,
      error: 'no active endpoint',
    };
  }

  const liveness = await checkEndpointLiveness(agent, endpoint);
  if (!liveness.ok) {
    return {
      message_id: msg.message_id,
      delivered: false,
      queued: true,
      error: liveness.error,
    };
  }

  try {
    const shouldArm = shouldArmLeaderGoalReminder(agent, senderAgent, ctx.metadata);
    await getQueue(endpoint.target, { role: agent.role }).enqueue({
      type: 'paste',
      text: fullText,
    });
    if (shouldArm) armLeaderGoalReminder(agent.name, agent.room_id);
    incrementRoomReminderDispatchCount(roomName);
    advancePushCursor(agent.name, msg.sequence);
    return {
      message_id: msg.message_id,
      delivered: true,
      queued: true,
    };
  } catch (e) {
    return {
      message_id: msg.message_id,
      delivered: false,
      queued: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function deliverMessage(
  senderName: string,
  room: string,
  text: string,
  targetName: string | null,
  replyTo?: number | null,
  metadata?: MessageDeliveryMetadata,
): Promise<DeliveryResult[]> {
  const roomObj = getRoom(room);
  const sender = roomObj
    ? (getAgentByRoomAndName(roomObj.id, senderName) ?? getAgent(senderName))
    : getAgent(senderName);

  if (metadata?.batch_id && sender?.role === 'worker') {
    const batchTerminal = recordBatchWorkerTerminalMessage({
      batchId: metadata.batch_id,
      workerName: senderName,
      roomId: roomObj?.id,
      terminalStatus: 'success',
      finalMessage: text,
    });

    if (batchTerminal) {
      if (batchTerminal.shouldFinalize) {
        const rendered = renderBatchFinalMessage(
          getRenderableBatchWorkers(batchTerminal.batchId),
        );
        void queueBatchFinalDelivery(
          batchTerminal.batchId,
          batchTerminal.leaderName,
          batchTerminal.roomId,
          rendered,
        ).catch((e) => {
          console.error(
            `[crew batch] final delivery failed for ${batchTerminal.batchId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }

      return [
        {
          message_id: '-1',
          delivered: false,
          queued: true,
        },
      ];
    }

    const knownBatch = getMessageBatch(metadata.batch_id);
    if (knownBatch && (!roomObj || knownBatch.room_id === roomObj.id)) {
      return [
        {
          message_id: '-1',
          delivered: false,
          queued: true,
        },
      ];
    }
  }

  // Build target list with pre-fetched agents for broadcasts
  const members = roomObj ? getRoomMembers(roomObj.id) : [];
  let targets: DeliveryContext[];

  if (targetName) {
    targets = [
      {
        to: targetName,
        senderName,
        roomName: room,
        text,
        fullText: '',
        targetName,
        replyTo,
        metadata,
      },
    ];
  } else {
    targets = members
      .filter((m) => m.name !== senderName)
      // Workers should not broadcast to peers — messages flow up the hierarchy
      .filter((m) => !(sender?.role === 'worker' && m.role === 'worker'))
      .map((m) => ({
        to: m.name,
        senderName,
        roomName: room,
        text,
        fullText: '',
        targetName: null as string | null,
        replyTo,
        metadata,
        agent: m,
      }));
  }

  // Deliver to all targets in parallel
  const settled = await Promise.allSettled(
    targets.map((ctx) => deliverToTarget(ctx)),
  );

  return settled.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          message_id: '-1',
          delivered: false,
          queued: false,
          error:
            r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}

export async function flushPushQueue(): Promise<void> {
  const agents = getAllAgents();
  const activeAgents = agents.filter((agent) => resolveActiveEndpoint(agent));

  for (const agent of activeAgents) {
    await flushPushQueueForAgent(agent);
  }
}

/**
 * Flush pending push messages for a single agent.
 * Used after unblock to immediately deliver queued messages
 * without waiting for the next sweep cycle.
 */
export async function flushPushQueueForAgent(agent: Agent): Promise<number> {
  const endpoint = resolveActiveEndpoint(agent);
  if (!endpoint) return 0;

  const blockMode = getAgentInputBlockMode(agent.name);
  if (blockMode !== 'off') return 0;

  const pane = endpoint.target;
  const cursor = getPushCursor(agent.name);
  const db = getDb();

  const rows = db
    .query(`
    SELECT m.*, r.name as room_name, s.role as sender_role
    FROM messages m
    JOIN rooms r ON r.id = m.room_id
    LEFT JOIN agents s ON s.name = m.sender AND s.room_id = m.room_id
    WHERE (m.recipient = ? OR (m.recipient IS NULL AND m.room_id = ? AND m.sender != ? AND (s.role IS NULL OR s.role != 'worker' OR ? = 'leader')))
      AND m.id > ?
    ORDER BY m.id
  `)
    .all(agent.name, agent.room_id, agent.name, agent.role, cursor) as Record<
    string,
    unknown
  >[];

  let delivered = 0;
  let nextCursor = cursor;
  for (const row of rows) {
    const sequence = Number(row.id);
    const from = String(row.sender);
    const text = String(row.text);
    const roomName = String(row.room_name);
    const pushText = `[${from}@${roomName}]: ${text}`;

    if (!claimPushCursor(agent.name, nextCursor, sequence)) {
      break;
    }

    try {
      await getQueue(pane, { role: agent.role }).enqueue({
        type: 'paste',
        text: pushText,
      });
      const senderRole = String(row.sender_role ?? '');
      const shouldArm = senderRole === 'worker' || row.batch_id != null;
      if (shouldArm) armLeaderGoalReminder(agent.name, agent.room_id);
      delivered++;
      nextCursor = sequence;
    } catch (e) {
      rollbackPushCursor(agent.name, nextCursor, sequence);
      if (e instanceof PaneDeliveryError && e.code === 'PANE_BLOCKED_INPUT') {
        break;
      }
      console.error(`Failed to push message ${sequence} to ${agent.name}:`, e);
      break;
    }
  }

  return delivered;
}
