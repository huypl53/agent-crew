import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { validateTmux } from './tmux/index.ts';
import { loadState, validateLiveness } from './state/index.ts';
import { handleJoinRoom } from './tools/join-room.ts';
import { handleLeaveRoom } from './tools/leave-room.ts';
import { handleListRooms } from './tools/list-rooms.ts';
import { handleListMembers } from './tools/list-members.ts';
import { handleSendMessage } from './tools/send-message.ts';
import { handleReadMessages } from './tools/read-messages.ts';
import { handleGetStatus } from './tools/get-status.ts';
import { handleSetRoomTopic } from './tools/set-room-topic.ts';
import { err } from './shared/types.ts';

// Validate tmux
const tmuxCheck = await validateTmux();
if (!tmuxCheck.ok) {
  console.error(tmuxCheck.error);
  process.exit(1);
}

// Load persisted state and validate liveness
await loadState();
const deadAgents = await validateLiveness();
if (deadAgents.length > 0) {
  console.error(`Cleaned up ${deadAgents.length} dead agent(s): ${deadAgents.join(', ')}`);
}

// Create MCP server
const server = new Server(
  { name: 'cc-tmux', version: '0.1.0' },
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
      case 'set_room_topic':
        return await handleSetRoomTopic(args as any);
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
