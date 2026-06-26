import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { deliverMessage } from '../delivery/index.ts';
import type { MessageDeliveryMetadata, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, getRoom, getRoomMembers } from '../state/index.ts';
import { resolveActiveEndpoint } from '../state/session-binding.ts';
import { getContextWindowForPane } from '../tokens/claude-code.ts';
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

function validateSenderEndpointConsistency(
  name: string,
  sender: NonNullable<ReturnType<typeof getAgent>>,
): string | null {
  if (config.senderVerification === 'off') return null;

  const callerPane = process.env.TMUX_PANE ?? null;
  const endpoint = resolveActiveEndpoint(sender);
  if (!callerPane || !endpoint) return null;
  if (endpoint.transport !== 'tmux' || endpoint.target === callerPane)
    return null;

  return `Sender mismatch: claimed "${name}" uses ${endpoint.transport}:${endpoint.target} but caller is tmux:${callerPane}`;
}

export function validateSenderAndRoom(
  room: string,
  name: string,
): {
  value?: {
    sender: NonNullable<ReturnType<typeof getAgent>>;
    room: NonNullable<ReturnType<typeof getRoom>>;
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

  const endpointMismatch = validateSenderEndpointConsistency(name, sender);
  if (endpointMismatch) {
    if (config.senderVerification === 'enforce') {
      return { error: endpointMismatch };
    }
    console.warn(`[sender-verification] ${endpointMismatch}`);
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

  const senderValue = senderContext.value;
  if (!senderValue) {
    return err('Failed to resolve sender context');
  }

  const { sender, room: r } = senderValue;

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
        let ctx_pct: number | null = null;
        if (agent.tmux_target) {
          try {
            const cw = await getContextWindowForPane(agent.tmux_target);
            if (cw) ctx_pct = cw.context_pct;
          } catch {
            // fail-open
          }
        }
        return {
          agent_id: agent.agent_id,
          name: agent.name,
          role: agent.role,
          status,
          input_block_mode: agent.input_block_mode,
          tmux_target: agent.tmux_target,
          ctx_pct,
        };
      }),
    );
  }

  if (results.length === 1) {
    const firstResult = results[0];
    if (!firstResult) {
      return err('Message delivery returned no results');
    }

    return ok({
      message_id: firstResult.message_id,
      delivered: firstResult.delivered,
      queued: firstResult.queued,
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
