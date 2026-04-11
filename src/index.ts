import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { validateTmux } from './tmux/index.ts';
import { validateLiveness } from './state/index.ts';
import { initDb } from './state/db.ts';
import { startTokenCollection } from './tokens/collector.ts';
import { handleJoinRoom } from './tools/join-room.ts';
import { handleLeaveRoom } from './tools/leave-room.ts';
import { handleListRooms } from './tools/list-rooms.ts';
import { handleListMembers } from './tools/list-members.ts';
import { handleSendMessage } from './tools/send-message.ts';
import { handleReadMessages } from './tools/read-messages.ts';
import { handleGetStatus } from './tools/get-status.ts';
import { handleSetRoomTopic } from './tools/set-room-topic.ts';
import { handleRefresh } from './tools/refresh.ts';
import { handleUpdateTask } from './tools/update-task.ts';
import { handleInterruptWorker } from './tools/interrupt-worker.ts';
import { handleReassignTask } from './tools/reassign-task.ts';
import { handleClearWorkerSession } from './tools/clear-worker-session.ts';
import { handleGetTaskDetails } from './tools/get-task-details.ts';
import { handleSearchTasks } from './tools/search-tasks.ts';
import { err } from './shared/types.ts';

// Validate tmux
const tmuxCheck = await validateTmux();
if (!tmuxCheck.ok) {
  console.error(tmuxCheck.error);
  process.exit(1);
}

// Initialize SQLite database
initDb();

// Validate liveness on startup
const deadAgents = await validateLiveness();
if (deadAgents.length > 0) {
  console.error(`Cleaned up ${deadAgents.length} dead agent(s): ${deadAgents.join(', ')}`);
}

// Create MCP server
const server = new Server(
  { name: 'crew', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

// Register tool list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'join_room',
      description: 'Register yourself in a named room with a role. Auto-detects your tmux pane.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: 'Room name to join' },
          role: { type: 'string', enum: ['boss', 'leader', 'worker'], description: 'Your role in this room' },
          name: { type: 'string', description: 'Your unique name in this room' },
          tmux_target: { type: 'string', description: 'Override auto-detected tmux pane (optional)' },
        },
        required: ['room', 'role', 'name'],
      },
    },
    {
      name: 'leave_room',
      description: 'Deregister yourself from a room. Discards unread messages for that room.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: 'Room to leave' },
          name: { type: 'string', description: 'Your agent name' },
        },
        required: ['room', 'name'],
      },
    },
    {
      name: 'list_rooms',
      description: 'List all active rooms with member counts and role breakdown.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'list_members',
      description: 'List all agents in a room with their names, roles, and status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: 'Room name' },
        },
        required: ['room'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to a specific agent or broadcast to all room members. Push mode delivers to tmux pane; pull mode queues only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: 'Room to send in' },
          text: { type: 'string', description: 'Message text' },
          name: { type: 'string', description: 'Your agent name (sender)' },
          to: { type: 'string', description: 'Target agent name (omit for broadcast)' },
          mode: { type: 'string', enum: ['push', 'pull'], description: 'Delivery mode (default: push)' },
          kind: { type: 'string', enum: ['task', 'completion', 'question', 'error', 'status', 'chat'], description: 'Message kind (default: chat)' },
        },
        required: ['room', 'text', 'name'],
      },
    },
    {
      name: 'read_messages',
      description: 'Read messages from your inbox. Supports cursor-based incremental retrieval and room filtering.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Your agent name' },
          room: { type: 'string', description: 'Filter by room (optional) — uses room log with cursor when provided' },
          since_sequence: { type: 'number', description: 'Return only messages after this sequence number (legacy inbox mode only)' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Filter by message kind (task, completion, question, error, status, chat)' },
          limit: { type: 'number', description: 'Max messages to return (default 50)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_status',
      description: 'Check an agent\'s status (idle, busy, dead, unknown) by inspecting their tmux pane.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_name: { type: 'string', description: 'Agent to check (optional, defaults to self)' },
          name: { type: 'string', description: 'Your agent name (for self-status)' },
        },
      },
    },
    {
      name: 'refresh',
      description: 'Re-register an existing agent with current tmux pane. Use after resuming a CC session. Migrates from legacy JSON state if needed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Your agent name' },
          tmux_target: { type: 'string', description: 'Override auto-detected tmux pane (optional)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'set_room_topic',
      description: 'Set the current objective/topic for a room. Only room members can set the topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: 'Room name' },
          text: { type: 'string', description: 'Topic or objective text' },
          name: { type: 'string', description: 'Your agent name' },
        },
        required: ['room', 'text', 'name'],
      },
    },
    {
      name: 'interrupt_worker',
      description: 'Interrupt a busy worker by sending Escape to their pane. Leader/Boss only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          worker_name: { type: 'string', description: 'Worker agent name to interrupt' },
          room: { type: 'string', description: 'Room the worker is in' },
          name: { type: 'string', description: 'Your agent name (caller)' },
        },
        required: ['worker_name', 'room', 'name'],
      },
    },
    {
      name: 'clear_worker_session',
      description: 'Clear a worker\'s Claude Code session and auto-refresh their registration. Leader/Boss only. Use between tasks to free context. Worker\'s next task must be self-contained.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          worker_name: { type: 'string', description: 'Worker agent name to clear' },
          room: { type: 'string', description: 'Room the worker is in' },
          name: { type: 'string', description: 'Your agent name (caller)' },
        },
        required: ['worker_name', 'room', 'name'],
      },
    },
    {
      name: 'reassign_task',
      description: 'Replace a worker\'s current or queued task with a new one. Leader/Boss only. Handles interrupt/clear automatically based on task state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          worker_name: { type: 'string', description: 'Worker agent name' },
          room: { type: 'string', description: 'Room the worker is in' },
          text: { type: 'string', description: 'New task text' },
          name: { type: 'string', description: 'Your agent name (caller)' },
        },
        required: ['worker_name', 'room', 'text', 'name'],
      },
    },
    {
      name: 'update_task',
      description: 'Update a task\'s status. Worker-only: you can only update tasks assigned to you.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID to update' },
          status: { type: 'string', enum: ['queued', 'active', 'completed', 'error'], description: 'New task status' },
          note: { type: 'string', description: 'Optional note (e.g., error message)' },
          context: { type: 'string', description: 'Worker context notes for handoff (what you learned, files explored, key findings)' },
          name: { type: 'string', description: 'Your agent name' },
        },
        required: ['task_id', 'status', 'name'],
      },
    },
    {
      name: 'get_task_details',
      description: 'Get full details of a task including worker context notes. Use to read what a previous worker learned.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID to look up' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'search_tasks',
      description: 'Search completed tasks by room, agent, keyword, or status. Use to find relevant context from previous work.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: 'Filter by room name' },
          assigned_to: { type: 'string', description: 'Filter by agent name' },
          keyword: { type: 'string', description: 'Search keyword (matches summary and context)' },
          status: { type: 'string', description: 'Filter by status (default: completed)' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
      },
    },
  ],
}));

// Route tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'join_room':
        return await handleJoinRoom(args as any);
      case 'leave_room':
        return await handleLeaveRoom(args as any);
      case 'list_rooms':
        return await handleListRooms();
      case 'list_members':
        return await handleListMembers(args as any);
      case 'send_message':
        return await handleSendMessage(args as any);
      case 'read_messages':
        return await handleReadMessages(args as any);
      case 'get_status':
        return await handleGetStatus(args as any);
      case 'refresh':
        return await handleRefresh(args as any);
      case 'set_room_topic':
        return await handleSetRoomTopic(args as any);
      case 'update_task':
        return await handleUpdateTask(args as any);
      case 'interrupt_worker':
        return await handleInterruptWorker(args as any);
      case 'clear_worker_session':
        return await handleClearWorkerSession(args as any);
      case 'reassign_task':
        return await handleReassignTask(args as any);
      case 'get_task_details':
        return await handleGetTaskDetails(args as any);
      case 'search_tasks':
        return await handleSearchTasks(args as any);
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(`Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);

// Start token collection
startTokenCollection();
