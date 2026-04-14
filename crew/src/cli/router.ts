import { handleJoinRoom } from '../tools/join-room.ts';
import { handleLeaveRoom } from '../tools/leave-room.ts';
import { handleListRooms } from '../tools/list-rooms.ts';
import { handleListMembers } from '../tools/list-members.ts';
import { handleSendMessage } from '../tools/send-message.ts';
import { handleReadMessages } from '../tools/read-messages.ts';
import { handleGetStatus } from '../tools/get-status.ts';
import { handleRefresh } from '../tools/refresh.ts';
import { handleSetRoomTopic } from '../tools/set-room-topic.ts';
import { handleUpdateTask } from '../tools/update-task.ts';
import { handleInterruptWorker } from '../tools/interrupt-worker.ts';
import { handleClearWorkerSession } from '../tools/clear-worker-session.ts';
import { handleReassignTask } from '../tools/reassign-task.ts';
import { handleGetTaskDetails } from '../tools/get-task-details.ts';
import { handleSearchTasks } from '../tools/search-tasks.ts';
import { handleCheckChanges } from '../tools/check-changes.ts';
import { handleCreateRoom } from '../tools/create-room.ts';
import { handleDeleteRoom } from '../tools/delete-room.ts';

type Handler = (params: any) => Promise<any>;
type ParamBuilder = (flags: Record<string, any>, positional: string[]) => any;

export const COMMANDS: Record<string, { handler: Handler; buildParams: ParamBuilder }> = {
  join:           { handler: handleJoinRoom, buildParams: (f) => ({ room: f.room, role: f.role, name: f.name, tmux_target: f.pane }) },
  leave:          { handler: handleLeaveRoom, buildParams: (f) => ({ room: f.room, name: f.name }) },
  rooms:          { handler: handleListRooms, buildParams: () => ({}) },
  members:        { handler: handleListMembers, buildParams: (f) => ({ room: f.room }) },
  send:           { handler: handleSendMessage, buildParams: (f) => ({ room: f.room, text: f.text, name: f.name, to: f.to, mode: f.mode ?? 'push', kind: f.kind ?? 'chat', reply_to: f['reply-to'] != null ? parseInt(String(f['reply-to']), 10) : undefined }) },
  read:           { handler: handleReadMessages, buildParams: (f) => ({ name: f.name, room: f.room, kinds: typeof f.kinds === 'string' ? f.kinds.split(',') : undefined, limit: f.limit ? parseInt(f.limit) : undefined }) },
  status:         { handler: handleGetStatus, buildParams: (f, p) => ({ agent_name: p[0] ?? f.agent, name: f.name }) },
  refresh:        { handler: handleRefresh, buildParams: (f) => ({ name: f.name, tmux_target: f.pane }) },
  topic:          { handler: handleSetRoomTopic, buildParams: (f) => ({ room: f.room, text: f.text, name: f.name }) },
  'update-task':  { handler: handleUpdateTask, buildParams: (f) => ({ task_id: parseInt(f.task), status: f.status, name: f.name, note: f.note, context: f.context }) },
  interrupt:      { handler: handleInterruptWorker, buildParams: (f) => ({ worker_name: f.worker, room: f.room, name: f.name }) },
  clear:          { handler: handleClearWorkerSession, buildParams: (f) => ({ worker_name: f.worker, room: f.room, name: f.name }) },
  reassign:       { handler: handleReassignTask, buildParams: (f) => ({ worker_name: f.worker, room: f.room, text: f.text, name: f.name }) },
  'task-details': { handler: handleGetTaskDetails, buildParams: (f, p) => ({ task_id: parseInt(p[0] ?? f.task) }) },
  'search-tasks': { handler: handleSearchTasks, buildParams: (f) => ({ room: f.room, assigned_to: f.agent, keyword: f.keyword, status: f.status, limit: f.limit ? parseInt(f.limit) : undefined }) },
  check:          { handler: handleCheckChanges, buildParams: (f) => ({ name: f.name, scopes: typeof f.scopes === 'string' ? f.scopes.split(',') : undefined }) },
  'create-room':  { handler: handleCreateRoom, buildParams: (f) => ({ room: f.room, topic: f.topic, name: f.name }) },
  'delete-room':  { handler: handleDeleteRoom, buildParams: (f) => ({ room: f.room, confirm: !!f.confirm, name: f.name }) },
};
