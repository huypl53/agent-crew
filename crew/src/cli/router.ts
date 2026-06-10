import { err } from '../shared/types.ts';
import { handleAutoSelf } from '../tools/auto-self.ts';
import { handleCheckChanges } from '../tools/check-changes.ts';
import { handleClearWorkerSession } from '../tools/clear-worker-session.ts';
import { handleCreateRoom } from '../tools/create-room.ts';
import { handleDeleteRoom } from '../tools/delete-room.ts';
import { handleGetStatus } from '../tools/get-status.ts';
import {
  handleHintLookup,
  handleHintSet,
  handleHintUnset,
} from '../tools/hint.ts';
import { handleHookEvent } from '../tools/hook-event.ts';
import { handleInputBlock } from '../tools/input-block.ts';
import { handleInspectWorker } from '../tools/inspect-worker.ts';
import { handleInterruptWorker } from '../tools/interrupt-worker.ts';
import { handleJoinRoom } from '../tools/join-room.ts';
import { handleLeaveRoom } from '../tools/leave-room.ts';
import { handleListMembers } from '../tools/list-members.ts';
import { handleListRooms } from '../tools/list-rooms.ts';
import { handleManage } from '../tools/manage.ts';
import { handleMuteIdle } from '../tools/mute-idle.ts';
import { handleParty } from '../tools/party.ts';
import {
  handlePausePolling,
  handlePolling,
  handlePollingStatus,
  handleResumePolling,
  handleSetPollingBusy,
} from '../tools/polling-control.ts';
import { handleReadMessages } from '../tools/read-messages.ts';
import { handleReassignTask } from '../tools/reassign-task.ts';
import { handleRefresh } from '../tools/refresh.ts';
import { handleSendMessage } from '../tools/send-message.ts';
import { handleSetRoomTopic } from '../tools/set-room-topic.ts';

type Handler = (params: unknown) => Promise<unknown>;
type ParamBuilder = (
  flags: Record<string, unknown>,
  positional: string[],
) => unknown;

export const COMMANDS: Record<
  string,
  { handler: Handler; buildParams: ParamBuilder }
> = {
  join: {
    handler: handleJoinRoom,
    buildParams: (f) => ({
      room: f.room,
      role: f.role,
      name: f.name,
      tmux_target: f.pane,
      room_id: f['room-id'] ? parseInt(String(f['room-id']), 10) : undefined,
    }),
  },
  leave: {
    handler: handleLeaveRoom,
    buildParams: (f) => ({ room: f.room, name: f.name }),
  },
  rooms: { handler: handleListRooms, buildParams: () => ({}) },
  members: {
    handler: handleListMembers,
    buildParams: (f) => ({ room: f.room }),
  },
  send: {
    handler: handleSendMessage,
    buildParams: (f) => ({
      room: f.room,
      text: f.text,
      file: f.file,
      name: f.name,
      to: f.to,
      mode: f.mode ?? 'push',
      kind: f.kind ?? 'chat',
      reply_to:
        f['reply-to'] != null ? parseInt(String(f['reply-to']), 10) : undefined,
      sender_pane: f['sender-pane'],
    }),
  },
  read: {
    handler: handleReadMessages,
    buildParams: (f) => ({
      name: f.name,
      room: f.room,
      kinds: typeof f.kinds === 'string' ? f.kinds.split(',') : undefined,
      limit: f.limit ? parseInt(f.limit, 10) : undefined,
    }),
  },
  status: {
    handler: handleGetStatus,
    buildParams: (f, p) => ({
      agent_name: p[0] ?? f.agent,
      name: f.name,
      self: !!f.self,
      inline: !!f.inline,
      json: !!f.json,
      session: typeof f.session === 'string' ? f.session : undefined,
    }),
  },
  refresh: {
    handler: handleRefresh,
    buildParams: (f) => ({ name: f.name, tmux_target: f.pane }),
  },
  topic: {
    handler: handleSetRoomTopic,
    buildParams: (f) => ({ room: f.room, text: f.text, name: f.name }),
  },
  interrupt: {
    handler: handleInterruptWorker,
    buildParams: (f) => ({ worker_name: f.worker, room: f.room, name: f.name }),
  },
  inspect: {
    handler: handleInspectWorker,
    buildParams: (f) => ({
      worker_name: f.worker,
      room: f.room,
      name: f.name,
      turns: f.turns ? parseInt(String(f.turns), 10) : undefined,
    }),
  },
  clear: {
    handler: handleClearWorkerSession,
    buildParams: (f) => ({ worker_name: f.worker, room: f.room, name: f.name }),
  },
  reassign: {
    handler: handleReassignTask,
    buildParams: (f) => ({
      worker_name: f.worker,
      room: f.room,
      text: f.text,
      name: f.name,
    }),
  },
  manage: {
    handler: handleManage,
    buildParams: (f) => ({ name: f.name }),
  },
  check: {
    handler: handleCheckChanges,
    buildParams: (f) => ({
      name: f.name,
      scopes: typeof f.scopes === 'string' ? f.scopes.split(',') : undefined,
    }),
  },
  'mute-idle': {
    handler: handleMuteIdle,
    buildParams: (f) => ({ name: f.name, action: 'mute' as const }),
  },
  'unmute-idle': {
    handler: handleMuteIdle,
    buildParams: (f) => ({ name: f.name, action: 'unmute' as const }),
  },
  mute: {
    handler: handleMuteIdle,
    buildParams: (f, p) => ({
      name: f.name,
      action: 'mute' as const,
      target: p[0],
    }),
  },
  unmute: {
    handler: handleMuteIdle,
    buildParams: (f, p) => ({
      name: f.name,
      action: 'unmute' as const,
      target: p[0],
    }),
  },
  'pause-polling': {
    handler: handlePausePolling,
    buildParams: (f) => ({ reason: f.reason }),
  },
  'resume-polling': {
    handler: handleResumePolling,
    buildParams: () => ({}),
  },
  'polling-status': {
    handler: handlePollingStatus,
    buildParams: () => ({}),
  },
  'set-polling-busy': {
    handler: handleSetPollingBusy,
    buildParams: (f) => ({ mode: f.mode }),
  },
  polling: {
    handler: handlePolling,
    buildParams: (f, p) => ({
      subcommand: p[0],
      reason: f.reason,
      mode: f.mode ?? p[1],
    }),
  },
  'create-room': {
    handler: handleCreateRoom,
    buildParams: (f) => ({ room: f.room, topic: f.topic, name: f.name }),
  },
  'delete-room': {
    handler: handleDeleteRoom,
    buildParams: (f, p) => ({
      room: f.room ?? p[0],
      confirm: !!f.confirm,
      name: f.name,
    }),
  },
  'hook-event': {
    handler: handleHookEvent,
    buildParams: () => ({}),
  },
  'input-block': {
    handler: handleInputBlock,
    buildParams: (f, p) => ({
      subcommand: p[0] ?? 'status',
      name: f.name,
      persist: !!f.persist,
    }),
  },
  ib: {
    handler: handleInputBlock,
    buildParams: (f, p) => ({
      subcommand: p[0] ?? 'status',
      name: f.name,
      persist: !!f.persist,
    }),
  },
  block: {
    handler: handleInputBlock,
    buildParams: (f) => ({
      subcommand: 'on',
      name: f.name,
      persist: !!f.persist,
    }),
  },
  unblock: {
    handler: handleInputBlock,
    buildParams: (f) => ({
      subcommand: 'off',
      name: f.name,
    }),
  },
  party: {
    handler: handleParty,
    buildParams: (f, p) => ({
      subcommand: p[0],
      room: f.room,
      topic: f.topic,
      worker: f.worker,
      name: f.name,
    }),
  },
  hint: {
    handler: async (p) => {
      const subcommand = p.subcommand;
      if (subcommand === 'set') return handleHintSet(p);
      if (subcommand === 'unset') return handleHintUnset(p);
      if (subcommand === 'lookup') return handleHintLookup(p);
      return err(
        `Unknown hint subcommand: '${subcommand ?? ''}'. Use: set, unset, lookup`,
      );
    },
    buildParams: (f, p) => ({
      subcommand: p[0],
      agent: f.agent,
      room: f.room,
      name: f.name,
      session: f.session,
      pane: f.pane,
      message: p.slice(1).join(' ') || undefined,
      cadence: f.cadence != null ? parseInt(String(f.cadence), 10) : undefined,
    }),
  },
  'auto-self': {
    handler: async (p) => handleAutoSelf(p),
    buildParams: (f, p) => ({ name: f.name, action: p[0] ?? 'on' }),
  },
};
