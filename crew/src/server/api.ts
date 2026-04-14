import {
  getAllRooms, getRoom, getRoomMembers, getRoomMessages,
  getAllAgents, getAgent, getAgentDbStatus,
  searchTasks, getTaskEvents,
  getChangeVersions,
  getLatestTokenUsage,
  getAgentMessageCounts,
  getAgentTaskStats,
} from '../state/index.ts';
import { getDb } from '../state/db.ts';
import {
  dbCreateRoom, dbDeleteRoom, dbSetTopic,
  dbUpdateAgentPersona, dbUpdateAgentCapabilities, dbDeleteAgent,
} from '../state/db-write.ts';
import { handleSendMessage } from '../tools/send-message.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function parseIntParam(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method.toUpperCase();

  // GET /api/rooms
  if (method === 'GET' && path === '/rooms') {
    return json(getAllRooms());
  }

  // GET /api/rooms/:name/members
  const roomMembersMatch = path.match(/^\/rooms\/([^/]+)\/members$/);
  if (method === 'GET' && roomMembersMatch) {
    const name = decodeURIComponent(roomMembersMatch[1]!);
    const room = getRoom(name);
    if (!room) return err('Room not found', 404);
    return json(getRoomMembers(name));
  }

  // GET /api/rooms/:name/messages?limit=&offset=
  const roomMsgMatch = path.match(/^\/rooms\/([^/]+)\/messages$/);
  if (method === 'GET' && roomMsgMatch) {
    const name = decodeURIComponent(roomMsgMatch[1]!);
    const room = getRoom(name);
    if (!room) return err('Room not found', 404);
    const limit = parseIntParam(url.searchParams.get('limit')) ?? 100;
    const offset = parseIntParam(url.searchParams.get('offset')) ?? 0;
    const msgs = getRoomMessages(name, offset, limit);
    return json(msgs);
  }

  // POST /api/rooms
  if (method === 'POST' && path === '/rooms') {
    const body = await req.json().catch(() => null);
    if (!body?.name) return err('Missing name');
    const result = dbCreateRoom(body.name, body.topic);
    if (result.error) return err(result.error);
    return json({ ok: true, name: body.name }, 201);
  }

  // DELETE /api/rooms/:name
  const roomDeleteMatch = path.match(/^\/rooms\/([^/]+)$/);
  if (method === 'DELETE' && roomDeleteMatch) {
    if (url.searchParams.get('confirm') !== 'true') return err('Pass ?confirm=true to delete');
    const name = decodeURIComponent(roomDeleteMatch[1]!);
    const result = dbDeleteRoom(name);
    if (result.error) return err(result.error);
    return json({ ok: true });
  }

  // GET /api/agents
  if (method === 'GET' && path === '/agents') {
    const agents = getAllAgents().map(a => ({
      ...a,
      status: getAgentDbStatus(a.name) ?? 'unknown',
    }));
    return json(agents);
  }

  // GET /api/agents/:name
  const agentGetMatch = path.match(/^\/agents\/([^/]+)$/);
  if (method === 'GET' && agentGetMatch) {
    const name = decodeURIComponent(agentGetMatch[1]!);
    const agent = getAgent(name);
    if (!agent) return err('Agent not found', 404);
    let token_usage: Record<string, unknown> | null = null;
    try { token_usage = getLatestTokenUsage(name) as Record<string, unknown> | null; } catch { /* table may not exist */ }
    const message_stats = getAgentMessageCounts(name);
    const task_stats = getAgentTaskStats(name);
    return json({ ...agent, status: getAgentDbStatus(name) ?? 'unknown', token_usage, message_stats, task_stats });
  }

  // GET /api/stats — aggregate counters for HeaderStats
  if (method === 'GET' && path === '/stats') {
    const agents = getAllAgents().map(a => ({ ...a, status: getAgentDbStatus(a.name) ?? 'unknown' }));
    const tasks = searchTasks({});
    let total_cost: number | null = null;
    let total_input_tokens = 0;
    let total_output_tokens = 0;
    try {
      for (const a of agents) {
        const tu = getLatestTokenUsage(a.name);
        if (tu) {
          total_cost = (total_cost ?? 0) + (tu.cost_usd ?? 0);
          total_input_tokens += tu.input_tokens ?? 0;
          total_output_tokens += tu.output_tokens ?? 0;
        }
      }
    } catch { /* token_usage table missing */ }
    return json({
      agents: {
        busy: agents.filter(a => a.status === 'busy').length,
        idle: agents.filter(a => a.status === 'idle').length,
        dead: agents.filter(a => a.status === 'dead').length,
        total: agents.length,
      },
      tasks: {
        done: tasks.filter(t => t.status === 'done').length,
        active: tasks.filter(t => t.status === 'active').length,
        queued: tasks.filter(t => t.status === 'queued').length,
        error: tasks.filter(t => t.status === 'error').length,
        total: tasks.length,
      },
      cost: { total_usd: total_cost, total_input_tokens, total_output_tokens },
    });
  }

  // POST /api/agents/:name/update
  const agentUpdateMatch = path.match(/^\/agents\/([^/]+)\/update$/);
  if (method === 'POST' && agentUpdateMatch) {
    const name = decodeURIComponent(agentUpdateMatch[1]!);
    const body = await req.json().catch(() => null);
    if (!body) return err('Missing body');
    if (body.persona !== undefined) {
      const r = dbUpdateAgentPersona(name, String(body.persona));
      if (r.error) return err(r.error);
    }
    if (body.capabilities !== undefined) {
      const caps = Array.isArray(body.capabilities) ? body.capabilities : String(body.capabilities).split(',').map((s: string) => s.trim()).filter(Boolean);
      const r = dbUpdateAgentCapabilities(name, caps);
      if (r.error) return err(r.error);
    }
    return json({ ok: true });
  }

  // DELETE /api/agents/:name
  const agentDeleteMatch = path.match(/^\/agents\/([^/]+)$/);
  if (method === 'DELETE' && agentDeleteMatch) {
    if (url.searchParams.get('confirm') !== 'true') return err('Pass ?confirm=true to delete');
    const name = decodeURIComponent(agentDeleteMatch[1]!);
    const result = dbDeleteAgent(name);
    if (result.error) return err(result.error);
    return json({ ok: true, removed_from_rooms: result.removed_from_rooms });
  }

  // GET /api/tasks?room=&status=&limit=
  if (method === 'GET' && path === '/tasks') {
    try {
      const db = getDb();
      let sql = 'SELECT id, room, assigned_to, created_by, summary, status, created_at, updated_at FROM tasks WHERE 1=1';
      const params: unknown[] = [];
      const room = url.searchParams.get('room');
      const status = url.searchParams.get('status');
      const limit = parseIntParam(url.searchParams.get('limit')) ?? 200;
      if (room) { sql += ' AND room = ?'; params.push(room); }
      if (status) { sql += ' AND status = ?'; params.push(status); }
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);
      const rows = db.query(sql).all(...params);
      return json(rows);
    } catch {
      return json([]);
    }
  }

  // GET /api/tasks/:id
  const taskMatch = path.match(/^\/tasks\/(\d+)$/);
  if (method === 'GET' && taskMatch) {
    try {
      const db = getDb();
      const id = parseInt(taskMatch[1]!, 10);
      const task = db.query('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) return err('Task not found', 404);
      let events: unknown[] = [];
      try { events = getTaskEvents(id); } catch {}
      return json({ ...(task as object), events });
    } catch {
      return err('Task not found', 404);
    }
  }

  // POST /api/messages
  if (method === 'POST' && path === '/messages') {
    const body = await req.json().catch(() => null);
    if (!body?.room || !body?.text || !body?.name) return err('Missing required: room, text, name');
    const result = await handleSendMessage({
      room: body.room,
      text: body.text,
      name: body.name,
      to: body.to,
      mode: body.mode ?? 'push',
      kind: body.kind ?? 'chat',
      reply_to: body.replyTo,
    });
    if (result.isError) return err(result.content[0]?.text ?? 'Send failed');
    return json({ ok: true });
  }

  // GET /api/check
  if (method === 'GET' && path === '/check') {
    const versions = getChangeVersions(['messages', 'agents', 'tasks', 'rooms']);
    return json(versions);
  }

  return err('Not found', 404);
}
