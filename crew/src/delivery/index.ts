import type { Agent, MessageKind } from '../shared/types.ts';
import { dbClearAgentPane } from '../state/db-write.ts';
import {
  addMessage,
  createTask,
  getAgent,
  getRoom,
  getRoomMembers,
  markAgentStale,
} from '../state/index.ts';
import {
  capturePaneTail,
  paneCommandLooksAlive,
  paneExists,
} from '../tmux/index.ts';
import { getQueue } from './pane-queue.ts';
import { parsePaneInputSection } from '../shared/pane-status.ts';

const NOTIFY_KINDS: MessageKind[] = ['completion', 'error', 'question'];

interface DeliveryResult {
  message_id: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
  task_id?: number;
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
  agent?: Agent;
}

async function deliverToTarget(ctx: DeliveryContext): Promise<DeliveryResult> {
  const {
    to,
    senderName,
    roomName,
    text,
    targetName,
    mode,
    kind,
    replyTo,
    fullText,
  } = ctx;

  const msg = addMessage(
    to,
    senderName,
    roomName,
    text,
    mode,
    targetName ?? to,
    kind,
    replyTo,
  );

  let taskId: number | undefined;
  if (kind === 'task') {
    const task = createTask(
      roomName,
      targetName ?? to,
      senderName,
      Number(msg.message_id),
      text,
    );
    taskId = task.id;
  }

  if (mode === 'push') {
    const agent = ctx.agent ?? getAgent(to);
    if (agent) {
      if (!agent.tmux_target) {
        return {
          message_id: msg.message_id,
          delivered: false,
          queued: true,
          error: 'pull-only agent: no tmux pane',
          task_id: taskId,
        };
      }
      if (!(await paneExists(agent.tmux_target))) {
        dbClearAgentPane(agent.name, agent.tmux_target);
        return {
          message_id: msg.message_id,
          delivered: false,
          queued: true,
          error: `Agent pane ${agent.tmux_target} no longer exists. Agent may need to rejoin.`,
          task_id: taskId,
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
            task_id: taskId,
          };
        }
      }
      try {
        await getQueue(agent.tmux_target, { role: agent.role }).enqueue({
          type: 'paste',
          text: fullText,
        });
        return {
          message_id: msg.message_id,
          delivered: true,
          queued: true,
          task_id: taskId,
        };
      } catch (e) {
        return {
          message_id: msg.message_id,
          delivered: false,
          queued: true,
          error: e instanceof Error ? e.message : String(e),
          task_id: taskId,
        };
      }
    } else {
      return {
        message_id: msg.message_id,
        delivered: false,
        queued: true,
        error: 'Agent not found',
        task_id: taskId,
      };
    }
  }

  return {
    message_id: msg.message_id,
    delivered: false,
    queued: true,
    task_id: taskId,
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
): Promise<DeliveryResult[]> {
  const header = `[${senderName}@${room}]:`;
  const fullText = `${header} ${text}`;
  const roomObj = getRoom(room);

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
        fullText,
        targetName,
        mode,
        kind,
        replyTo,
      },
    ];
  } else {
    targets = members
      .filter((m) => m.name !== senderName)
      .map((m) => ({
        to: m.name,
        senderName,
        roomName: room,
        text,
        fullText,
        targetName: null as string | null,
        mode,
        kind,
        replyTo,
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
  if (NOTIFY_KINDS.includes(kind)) {
    const sender = getAgent(senderName);
    if (sender?.role === 'worker') {
      const leaders = members.filter(
        (m) => m.role === 'leader' && m.name !== senderName && m.tmux_target,
      );

      if (leaders.length > 0) {
        const summary = text.length > 200 ? `${text.slice(0, 197)}...` : text;
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
          leaders.map((leader) => {
            const target = leader.tmux_target;
            if (!target) return Promise.resolve();
            return getQueue(target, { role: leader.role }).enqueue({
              type: 'paste',
              text: notifyText,
            });
          }),
        );
      }
    }
  }

  return results;
}
