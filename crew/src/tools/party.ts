import {
  deliverPartyDigest,
  deliverPartyTopic,
} from '../delivery/party-delivery.ts';
import { resetPartyTimeoutTracking } from '../server/sweep.ts';
import type { ToolResult } from '../shared/types.ts';
import {
  endParty,
  getAgentByName,
  getPartyResponses,
  getPartyState,
  getPendingPartyWorkers,
  getRoom,
  getRoomMembers,
  nextPartyRound,
  skipPartyWorker,
  startParty,
} from '../state/index.ts';

interface PartyParams {
  subcommand: string;
  room?: string;
  topic?: string;
  worker?: string;
  name?: string;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(msg: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
    isError: true,
  };
}

export async function handleParty(params: PartyParams): Promise<ToolResult> {
  const { subcommand, room: roomName, topic, worker, name } = params;

  // For mutating commands, --name is required for auth
  const isMutating = subcommand !== 'status';
  if (isMutating && !name) {
    return err('--name required for party control commands');
  }

  let roomId: number;
  let callerAgent: ReturnType<typeof getAgentByName> | undefined;

  if (name) {
    callerAgent = getAgentByName(name);
    if (!callerAgent) return err(`Agent "${name}" not found`);
    roomId = callerAgent.room_id;
  } else if (roomName) {
    const r = getRoom(roomName);
    if (!r) return err(`Room "${roomName}" not found`);
    roomId = r.id;
  } else {
    return err('Either --room or --name required');
  }

  // Leader-only check for mutating commands
  if (isMutating && callerAgent?.role !== 'leader') {
    return err('Only leaders can control party mode');
  }

  switch (subcommand) {
    case 'start':
      return handleStart(roomId, topic);
    case 'next':
      return handleNext(roomId, topic);
    case 'end':
      return handleEnd(roomId);
    case 'skip':
      return handleSkip(roomId, worker);
    case 'status':
      return handleStatus(roomId);
    default:
      return err(
        `Unknown subcommand: ${subcommand}. Use: start, next, end, skip, status`,
      );
  }
}

async function handleStart(
  roomId: number,
  topic?: string,
): Promise<ToolResult> {
  if (!topic) return err('--topic required for party start');

  const state = getPartyState(roomId);
  if (state?.active) return err('Party already active. Use "party end" first.');

  startParty(roomId, topic);
  resetPartyTimeoutTracking(roomId);

  const workers = getRoomMembers(roomId).filter((m) => m.role === 'worker');
  await deliverPartyTopic(roomId, 1, topic, workers);

  return ok({
    started: true,
    round: 1,
    topic,
    workers: workers.map((w) => w.name),
  });
}

async function handleNext(roomId: number, topic?: string): Promise<ToolResult> {
  if (!topic) return err('--topic required for party next');

  const state = getPartyState(roomId);
  if (!state?.active) return err('No active party. Use "party start" first.');

  const prevRound = state.round;
  const prevResponses = getPartyResponses(roomId, prevRound);

  const newRound = nextPartyRound(roomId, topic);
  resetPartyTimeoutTracking(roomId);

  const workers = getRoomMembers(roomId).filter((m) => m.role === 'worker');
  await deliverPartyTopic(roomId, newRound, topic, workers, prevResponses);

  return ok({ round: newRound, topic, workers: workers.map((w) => w.name) });
}

async function handleEnd(roomId: number): Promise<ToolResult> {
  const state = getPartyState(roomId);
  if (!state?.active) return err('No active party');

  endParty(roomId);
  resetPartyTimeoutTracking(roomId);
  return ok({ ended: true, rounds_completed: state.round });
}

async function handleSkip(
  roomId: number,
  workerName?: string,
): Promise<ToolResult> {
  if (!workerName) return err('--worker required for party skip');

  const state = getPartyState(roomId);
  if (!state?.active) return err('No active party');

  // Validate worker exists in room
  const roomWorkers = getRoomMembers(roomId).filter((m) => m.role === 'worker');
  if (!roomWorkers.some((w) => w.name === workerName)) {
    return err(`Worker "${workerName}" not found in room`);
  }

  skipPartyWorker(roomId, state.round, workerName);

  const pending = getPendingPartyWorkers(roomId, state.round);
  if (pending.length === 0) {
    const responses = getPartyResponses(roomId, state.round);
    const leaders = getRoomMembers(roomId).filter((m) => m.role === 'leader');
    await deliverPartyDigest(roomId, state.round, responses, leaders);
  }

  return ok({ skipped: workerName, pending });
}

async function handleStatus(roomId: number): Promise<ToolResult> {
  const state = getPartyState(roomId);
  if (!state) return err('Room not found');

  if (!state.active) {
    return ok({ active: false });
  }

  const responses = getPartyResponses(roomId, state.round);
  const pending = getPendingPartyWorkers(roomId, state.round);

  return ok({
    active: true,
    round: state.round,
    topic: state.topic,
    responded: responses.map((r) => r.agent_name),
    pending,
    started_at: state.started_at,
  });
}
