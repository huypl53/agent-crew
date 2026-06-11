import { config } from '../config.ts';
import { parsePaneInputSection } from '../shared/pane-status.ts';
import type {
  Agent,
  MessageDeliveryMetadata,
  MessageKind,
} from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import { dbClearAgentPane } from '../state/db-write.ts';
import {
  addMessage,
  advancePushCursor,
  getAgent,
  getAgentByRoomAndName,
  getAgentInputBlockMode,
  getMessageBatch,
  getAllAgents,
  getPushCursor,
  getRenderableBatchWorkers,
  getRoom,
  getRoomMembers,
  getRoomReminderDispatchCount,
  incrementRoomReminderDispatchCount,
  markAgentStale,
  queueBatchFinalDelivery,
  recordBatchWorkerTerminalMessage,
} from '../state/index.ts';
import { renderBatchFinalMessage } from '../state/batch-render.ts';
import {
  capturePaneTail,
  paneCommandLooksAlive,
  paneExists,
} from '../tmux/index.ts';
import { getQueue, PaneDeliveryError } from './pane-queue.ts';

const NOTIFY_KINDS: MessageKind[] = ['completion', 'error', 'question'];

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
  mode: 'push' | 'pull';
  kind: MessageKind;
  replyTo?: number | null;
  metadata?: MessageDeliveryMetadata;
  agent?: Agent;
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

async function deliverToTarget(ctx: DeliveryContext): Promise<DeliveryResult> {
  const { to, senderName, roomName, text, targetName, mode, kind, replyTo } =
    ctx;
  const targetAgent = ctx.agent ?? getAgent(to);
  const outgoingText = decorateMessageWithReminder(text, roomName, targetAgent);
  const header = `[${senderName}@${roomName}]:`;
  const fullText = `${header} ${outgoingText}`;

  const msg = addMessage(
    to,
    senderName,
    roomName,
    outgoingText,
    mode,
    targetName ?? to,
    kind,
    replyTo,
    ctx.metadata,
  );

  if (mode === 'push') {
    const agent = ctx.agent ?? getAgent(to);
    if (agent) {
      if (!agent.tmux_target) {
        return {
          message_id: msg.message_id,
          delivered: false,
          queued: true,
          error: 'pull-only agent: no tmux pane',
        };
      }
      if (!(await paneExists(agent.tmux_target))) {
        dbClearAgentPane(agent.name, agent.tmux_target);
        return {
          message_id: msg.message_id,
          delivered: false,
          queued: true,
          error: `Agent pane ${agent.tmux_target} no longer exists. Agent may need to rejoin.`,
        };
      }
      if (agent.agent_type === 'claude-code' || agent.agent_type === 'codex') {
        if (!(await paneCommandLooksAlive(agent.tmux_target))) {
          markAgentStale(agent.name);
          return {
            message_id: msg.message_id,
            delivered: false,
            queued: true,
            error: `stale-target: pane ${agent.tmux_target} is not running an agent process`,
          };
        }
      }
      try {
        await getQueue(agent.tmux_target, { role: agent.role }).enqueue({
          type: 'paste',
          text: fullText,
        });
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
    } else {
      return {
        message_id: msg.message_id,
        delivered: false,
        queued: true,
        error: 'Agent not found',
      };
    }
  }

  return {
    message_id: msg.message_id,
    delivered: false,
    queued: true,
  };
}

export async function deliverMessage(
  senderName: string,
  room: string,
  text: string,
  targetName: string | null,
  mode: 'push' | 'pull',
  kind: MessageKind = 'chat',
  replyTo?: number | null,
  metadata?: MessageDeliveryMetadata,
): Promise<DeliveryResult[]> {
  const roomObj = getRoom(room);
  const sender = roomObj
    ? getAgentByRoomAndName(roomObj.id, senderName) ?? getAgent(senderName)
    : getAgent(senderName);

  if (
    metadata?.batch_id &&
    sender?.role === 'worker' &&
    (kind === 'completion' || kind === 'error')
  ) {
    const batchTerminal = recordBatchWorkerTerminalMessage({
      batchId: metadata.batch_id,
      workerName: senderName,
      roomId: roomObj?.id,
      terminalStatus: kind === 'error' ? 'error' : 'success',
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
        mode,
        kind,
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
        mode,
        kind,
        replyTo,
        metadata,
        agent: m,
      }));
  }

  // Deliver to all targets in parallel
  const settled = await Promise.allSettled(
    targets.map((ctx) => deliverToTarget(ctx)),
  );

  const results: DeliveryResult[] = settled.map((r) =>
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

  // Auto-notify: if sender is worker and kind is notifiable, push summary to leaders
  if (NOTIFY_KINDS.includes(kind) && !metadata?.batch_id) {
    if (sender?.role === 'worker') {
      const leaders = members.filter(
        (m) => m.role === 'leader' && m.name !== senderName && m.tmux_target,
      );

      if (leaders.length > 0) {
        const summary =
          text.length > config.notifyMaxChars
            ? `${text.slice(0, config.notifyMaxChars - 3)}...`
            : text;
        let notifyText = `[system@${room}]: ${senderName} ${kind}: "${summary}"`;

        if (sender.tmux_target) {
          const tail = await capturePaneTail(sender.tmux_target, 20).catch(
            () => null,
          );
          if (tail) {
            const sanitized = parsePaneInputSection(tail).sanitized;
            const flatTail = sanitized
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .join(' | ');
            if (flatTail) notifyText += ` [context: ${flatTail}]`;
          }
        }

        // Push notifications to all leaders in parallel
        await Promise.allSettled(
          leaders.map(async (leader) => {
            const target = leader.tmux_target;
            if (!target) return;
            await getQueue(target, { role: leader.role }).enqueue({
              type: 'paste',
              text: notifyText,
            });
            const matchedResult = results.find((r) => r.message_id !== '-1');
            if (matchedResult) {
              const seq = parseInt(matchedResult.message_id, 10);
              if (!Number.isNaN(seq)) {
                advancePushCursor(leader.name, seq);
              }
            }
          }),
        );
      }
    }
  }

  return results;
}

export async function flushPushQueue(): Promise<void> {
  const agents = getAllAgents();
  const activeAgents = agents.filter((a) => a.tmux_target);

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
  if (!agent.tmux_target) return 0;

  const blockMode = getAgentInputBlockMode(agent.name);
  if (blockMode !== 'off') return 0;

  const pane = agent.tmux_target;
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
  for (const row of rows) {
    const sequence = Number(row.id);
    const from = String(row.sender);
    const text = String(row.text);
    const kind = String(row.kind ?? 'chat');
    const mode = row.mode ? String(row.mode) : null;
    const roomName = String(row.room_name);

    let pushText: string | null = null;
    if (mode === 'push') {
      pushText = `[${from}@${roomName}]: ${text}`;
    } else if (mode === 'pull' && NOTIFY_KINDS.includes(kind as any)) {
      const summary =
        text.length > config.notifyMaxChars
          ? `${text.slice(0, config.notifyMaxChars - 3)}...`
          : text;
      pushText = `[system@${roomName}]: ${from} ${kind}: "${summary}"`;
    }

    if (pushText !== null) {
      try {
        await getQueue(pane, { role: agent.role }).enqueue({
          type: 'paste',
          text: pushText,
        });
        delivered++;
      } catch (e) {
        if (e instanceof PaneDeliveryError && e.code === 'PANE_BLOCKED_INPUT') {
          break;
        }
        console.error(
          `Failed to push message ${sequence} to ${agent.name}:`,
          e,
        );
        break;
      }
    }

    advancePushCursor(agent.name, sequence);
  }

  return delivered;
}
