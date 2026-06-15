import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { deliverMessage } from '../delivery/index.ts';
import type { MessageDeliveryMetadata, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, getRoom, getRoomMembers } from '../state/index.ts';
import { resolveAgentLiveStatus } from './get-status.ts';

interface SendMessageParams {
  room: string;
  text?: string;
  file?: string;
  to?: string;
  name: string; // sender identity
  reply_to?: number;
  metadata?: MessageDeliveryMetadata;
}

const MAX_MESSAGE_FILE_BYTES = 256 * 1024;

export interface Utf8TextFileResult {
  text?: string;
  resolvedPath?: string;
  error?: string;
}

export async function readUtf8TextFile(
  filePath: string,
  label: string,
): Promise<Utf8TextFileResult> {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return { error: `${label} file path must not be empty` };
  }

  const resolvedPath = resolve(trimmedPath);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolvedPath);
  } catch (error) {
    return {
      error: `Unable to read ${label.toLowerCase()} file "${trimmedPath}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (bytes.byteLength === 0) {
    return { error: `${label} file "${trimmedPath}" is empty` };
  }

  if (bytes.byteLength > MAX_MESSAGE_FILE_BYTES) {
    return {
      error: `${label} file "${trimmedPath}" exceeds ${MAX_MESSAGE_FILE_BYTES} bytes`,
    };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, resolvedPath };
  } catch {
    return { error: `${label} file is not valid UTF-8: "${trimmedPath}"` };
  }
}

export function validateSenderAndRoom(
  room: string,
  name: string,
): {
  value?: {
    sender: ReturnType<typeof getAgent>;
    room: ReturnType<typeof getRoom>;
  };
  error?: string;
} {
  if (!room || !name) {
    return { error: 'Missing required params: room, name' };
  }

  const sender = getAgent(name);
  if (!sender) {
    return { error: `Sender "${name}" is not registered` };
  }

  const roomObj = getRoom(room);
  if (!roomObj) {
    return { error: `Room "${room}" does not exist` };
  }

  if (sender.room_id !== roomObj.id) {
    return { error: `Sender "${name}" is not a member of room "${room}"` };
  }

  // Sender verification: compare claimed sender's registered pane against the
  // tmux pane that originated this call (available via $TMUX_PANE in the process env).
  if (config.senderVerification !== 'off') {
    const callerPane = process.env.TMUX_PANE ?? null;
    if (callerPane && sender.tmux_target && callerPane !== sender.tmux_target) {
      const msg = `Sender mismatch: claimed "${name}" (pane ${sender.tmux_target}) but caller is pane ${callerPane}`;
      if (config.senderVerification === 'enforce') {
        return { error: msg };
      }
      console.warn(`[sender-verification] ${msg}`);
    }
  }

  return { value: { sender, room: roomObj } };
}

async function resolveMessageText(
  params: SendMessageParams,
): Promise<{ text?: string; error?: string }> {
  const hasText = typeof params.text === 'string';
  const hasFile = typeof params.file === 'string';

  if (hasText === hasFile) {
    return { error: 'Provide exactly one of --text or --file' };
  }

  if (hasText) {
    return params.text
      ? { text: params.text }
      : { error: 'Missing required params: room, text, name' };
  }

  const filePath = params.file;
  if (!filePath) {
    return { error: 'Message file path must not be empty' };
  }

  return readUtf8TextFile(filePath, 'Message');
}

export async function handleSendMessage(
  params: SendMessageParams,
): Promise<ToolResult> {
  const { room, to, name, reply_to } = params;

  if (!room || !name) {
    return err('Missing required params: room, name');
  }

  const resolved = await resolveMessageText(params);
  if (resolved.error) {
    return err(resolved.error);
  }
  const text = resolved.text!;

  const senderContext = validateSenderAndRoom(room, name);
  if (senderContext.error) {
    return err(senderContext.error);
  }

  const { sender, room: r } = senderContext.value!;

  // Validate target if directed message
  if (to) {
    const target = getAgent(to);
    if (!target) {
      return err(`Target agent "${to}" is not registered`);
    }
    if (target.room_id !== r.id) {
      return err(`Target "${to}" is not a member of room "${room}"`);
    }
  }

  const results = await deliverMessage(
    name,
    room,
    text,
    to ?? null,
    reply_to,
    params.metadata,
  );

  const senderIsLeader = sender.role === 'leader';
  let hasWorkerDelivered = false;

  if (senderIsLeader) {
    if (to) {
      const target = getAgent(to);
      if (target?.role === 'worker' && results[0]?.delivered) {
        hasWorkerDelivered = true;
      }
    } else {
      const members = getRoomMembers(r.id);
      const targets = members.filter((m) => m.name !== name);
      for (let i = 0; i < results.length; i++) {
        const targetAgent = targets[i];
        if (
          targetAgent &&
          targetAgent.role === 'worker' &&
          results[i]?.delivered
        ) {
          hasWorkerDelivered = true;
          break;
        }
      }
    }
  }

  let membersStatus: any[] | undefined;
  if (hasWorkerDelivered) {
    membersStatus = await Promise.all(
      getRoomMembers(r.id).map(async (agent) => {
        const status = await resolveAgentLiveStatus(agent);
        return {
          agent_id: agent.agent_id,
          name: agent.name,
          role: agent.role,
          status,
          input_block_mode: agent.input_block_mode,
        };
      }),
    );
  }

  if (results.length === 1) {
    return ok({
      message_id: results[0]!.message_id,
      delivered: results[0]!.delivered,
      queued: results[0]!.queued,
      ...(membersStatus ? { members: membersStatus } : {}),
    });
  }

  // Broadcast: return summary
  const delivered = results.filter((r) => r.delivered).length;
  return ok({
    broadcast: true,
    recipients: results.length,
    delivered,
    queued: results.length,
    message_ids: results.map((r) => r.message_id),
    ...(membersStatus ? { members: membersStatus } : {}),
  });
}
