import { randomSuffix } from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import {
  dbCreateRoom,
  dbCreateRoomTemplate,
  dbCreateTemplate,
  dbDeleteAgent,
  dbDeleteRoom,
  dbDeleteRoomTemplate,
  dbDeleteTemplate,
  dbSetRoomTemplates,
  dbSetTopic,
  dbUpdateAgentCapabilities,
  dbUpdateAgentPersona,
  dbUpdateRoomTemplate,
  dbUpdateTemplate,
} from '../state/db-write.ts';
import {
  getAgent,
  getAgentByRoomAndName,
  getAgentDbStatus,
  getAgentMessageCounts,
  getAgentTaskStats,
  getAgentTemplateById,
  getAllAgents,
  getAllRooms,
  getAllRoomTemplates,
  getAllTaskEvents,
  getAllTemplates,
  getChangeVersions,
  getLatestTokenUsage,
  getRoom,
  getRoomMembers,
  getRoomMessages,
  getRoomTemplateDefinition,
  getRoomTemplateNames,
  getTaskEvents,
  searchTasks,
} from '../state/index.ts';
import { handleSendMessage } from '../tools/send-message.ts';
import { getWorkerSweepStates } from './sweep.ts';

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

function shellQuote(input: string): string {
  return `'${String(input).replace(/'/g, `'"'"'`)}'`;
}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method.toUpperCase();

  // GET /api/rooms
  if (method === 'GET' && path === '/rooms') {
    const rooms = getAllRooms().map((r) => ({
      ...r,
      member_count: getRoomMembers(r.id).length,
      template_names: getRoomTemplateNames(r.name),
    }));
    return json(rooms);
  }

  // GET /api/rooms/:name (single room with template_names)
  const singleRoomMatch = path.match(/^\/rooms\/([^/]+)$/);
  if (method === 'GET' && singleRoomMatch) {
    const name = decodeURIComponent(singleRoomMatch[1]!);
    const room = getRoom(name);
    if (!room) return err('Room not found', 404);
    return json({ ...room, template_names: getRoomTemplateNames(name) });
  }

  // GET /api/rooms/:name/members
  const roomMembersMatch = path.match(/^\/rooms\/([^/]+)\/members$/);
  if (method === 'GET' && roomMembersMatch) {
    const name = decodeURIComponent(roomMembersMatch[1]!);
    const room = getRoom(name);
    if (!room) return err('Room not found', 404);
    return json(getRoomMembers(room.id));
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

  // GET /api/rooms/:name/tmux-windows
  const roomWindowsMatch = path.match(/^\/rooms\/([^/]+)\/tmux-windows$/);
  if (method === 'GET' && roomWindowsMatch) {
    const name = decodeURIComponent(roomWindowsMatch[1]!);
    const room = getRoom(name);
    if (!room) return err('Room not found', 404);
    const members = getRoomMembers(room.id).filter((m) => !!m.tmux_target);
    if (members.length === 0) return err('No tmux agents in room', 400);

    const { getPaneSessionName, listSessionWindows } = await import(
      '../tmux/index.ts'
    );

    const sessionName = await getPaneSessionName(members[0]!.tmux_target!);
    if (!sessionName) return err('Could not resolve tmux session', 400);

    const windows = await listSessionWindows(sessionName).catch(() => null);
    if (!windows) return err('Failed to list tmux windows', 400);

    const activeWindowIndex =
      windows.find((window) => window.active)?.index ?? null;

    return json({
      session: sessionName,
      active_window_index: activeWindowIndex,
      windows,
    });
  }

  // POST /api/rooms
  if (method === 'POST' && path === '/rooms') {
    const body = await req.json().catch(() => null);
    if (!body?.name) return err('Missing name');
    const result = dbCreateRoom(
      body.name,
      body.topic,
      Array.isArray(body.templateIds) ? body.templateIds : undefined,
    );
    if (result.error) return err(result.error);
    return json({ ok: true, name: body.name }, 201);
  }

  // DELETE /api/rooms/:name   PATCH /api/rooms/:name
  const roomDeleteMatch = path.match(/^\/rooms\/([^/]+)$/);
  if (method === 'DELETE' && roomDeleteMatch) {
    if (url.searchParams.get('confirm') !== 'true')
      return err('Pass ?confirm=true to delete');
    const name = decodeURIComponent(roomDeleteMatch[1]!);
    const result = dbDeleteRoom(name);
    if (result.error) return err(result.error);
    return json({ ok: true });
  }
  if (method === 'PATCH' && roomDeleteMatch) {
    const name = decodeURIComponent(roomDeleteMatch[1]!);
    const body = await req.json().catch(() => null);
    if (!body?.topic) return err('Missing topic');
    const r = dbSetTopic(name, body.topic);
    return r.error ? err(r.error) : json({ ok: true });
  }

  // PATCH /api/rooms/:name/templates — update room's cast (agent templates)
  const roomTemplatesMatch = path.match(/^\/rooms\/([^/]+)\/templates$/);
  if (method === 'PATCH' && roomTemplatesMatch) {
    const name = decodeURIComponent(roomTemplatesMatch[1]!);
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.templateIds))
      return err('Missing templateIds array');
    const r = dbSetRoomTemplates(name, body.templateIds);
    return r.error ? err(r.error) : json({ ok: true });
  }

  // GET /api/agents
  if (method === 'GET' && path === '/agents') {
    const sweepStates = getWorkerSweepStates();
    const agents = getAllAgents().map((a) => ({
      ...a,
      status: getAgentDbStatus(a.name) ?? 'unknown',
      sweep: sweepStates[a.name] ?? null,
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
    try {
      token_usage = getLatestTokenUsage(name) as Record<string, unknown> | null;
    } catch {
      /* table may not exist */
    }
    const message_stats = getAgentMessageCounts(name);
    const task_stats = getAgentTaskStats(name);
    const sweepStates = getWorkerSweepStates();
    return json({
      ...agent,
      status: getAgentDbStatus(name) ?? 'unknown',
      token_usage,
      message_stats,
      task_stats,
      sweep: sweepStates[name] ?? null,
    });
  }

  // GET /api/stats — aggregate counters for HeaderStats
  if (method === 'GET' && path === '/stats') {
    const agents = getAllAgents().map((a) => ({
      ...a,
      status: getAgentDbStatus(a.name) ?? 'unknown',
    }));
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
    } catch {
      /* token_usage table missing */
    }
    return json({
      agents: {
        busy: agents.filter((a) => a.status === 'busy').length,
        idle: agents.filter((a) => a.status === 'idle').length,
        dead: agents.filter((a) => a.status === 'dead').length,
        total: agents.length,
      },
      tasks: {
        done: tasks.filter((t) => t.status === 'done').length,
        active: tasks.filter((t) => t.status === 'active').length,
        queued: tasks.filter((t) => t.status === 'queued').length,
        error: tasks.filter((t) => t.status === 'error').length,
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
      const caps = Array.isArray(body.capabilities)
        ? body.capabilities
        : String(body.capabilities)
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
      const r = dbUpdateAgentCapabilities(name, caps);
      if (r.error) return err(r.error);
    }
    return json({ ok: true });
  }

  // DELETE /api/agents/:name
  const agentDeleteMatch = path.match(/^\/agents\/([^/]+)$/);
  if (method === 'DELETE' && agentDeleteMatch) {
    if (url.searchParams.get('confirm') !== 'true')
      return err('Pass ?confirm=true to delete');
    const name = decodeURIComponent(agentDeleteMatch[1]!);
    const result = dbDeleteAgent(name);
    if (result.error) return err(result.error);
    return json({ ok: true, removed_from_rooms: result.removed_from_rooms });
  }

  // GET /api/tasks?room=&status=&limit=
  if (method === 'GET' && path === '/tasks') {
    try {
      const db = getDb();
      let sql =
        'SELECT id, room, assigned_to, created_by, summary, status, created_at, updated_at FROM tasks WHERE 1=1';
      const params: unknown[] = [];
      const room = url.searchParams.get('room');
      const status = url.searchParams.get('status');
      const limit = parseIntParam(url.searchParams.get('limit')) ?? 200;
      if (room) {
        sql += ' AND room = ?';
        params.push(room);
      }
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);
      const rows = db.query(sql).all(...params);
      return json(rows);
    } catch {
      return json([]);
    }
  }

  // GET /api/tasks/events — all task events for timeline (readonly-safe)
  if (method === 'GET' && path === '/tasks/events') {
    try {
      return json(getAllTaskEvents());
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
      try {
        events = getTaskEvents(id);
      } catch {}
      return json({ ...(task as object), events });
    } catch {
      return err('Task not found', 404);
    }
  }

  // POST /api/messages
  if (method === 'POST' && path === '/messages') {
    const body = await req.json().catch(() => null);
    if (!body?.room || !body?.text || !body?.name)
      return err('Missing required: room, text, name');
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
    const versions = getChangeVersions([
      'messages',
      'agents',
      'tasks',
      'rooms',
    ]);
    return json(versions);
  }

  // GET /api/trace — aggregate payload for trace view (rooms + agents + tasks + recent messages)
  if (method === 'GET' && path === '/trace') {
    try {
      const db = getDb();
      const rooms = getAllRooms();
      const agents = getAllAgents().map((a) => ({
        ...a,
        status: getAgentDbStatus(a.name) ?? 'unknown',
      }));
      const tasks = db
        .query('SELECT * FROM tasks ORDER BY id DESC LIMIT 500')
        .all();
      let messages: unknown[] = [];
      try {
        const rows = db
          .query('SELECT * FROM messages ORDER BY id DESC LIMIT 500')
          .all() as Record<string, unknown>[];
        messages = rows.map((r) => ({
          message_id: String(r['id']),
          from: String(r['sender'] ?? ''),
          to: (r['recipient'] as string | null) ?? null,
          room: String(r['room'] ?? ''),
          text: String(r['text'] ?? ''),
          kind: String(r['kind'] ?? 'chat'),
          mode: (r['mode'] as 'push' | 'pull') ?? 'push',
          timestamp: String(r['timestamp'] ?? ''),
          sequence: Number(r['id']),
          reply_to: (r['reply_to'] as number | null) ?? null,
        }));
      } catch {
        /* messages table may not exist */
      }
      return json({ rooms, agents, tasks, messages });
    } catch (e) {
      return err(String(e));
    }
  }

  // GET /api/templates
  if (method === 'GET' && path === '/templates') return json(getAllTemplates());

  // POST /api/templates
  if (method === 'POST' && path === '/templates') {
    const body = await req.json().catch(() => null);
    if (!body?.name || !body?.role) return err('Missing name or role');
    const r = dbCreateTemplate(
      body.name,
      body.role,
      body.persona,
      body.capabilities,
      body.start_command,
    );
    return r.error ? err(r.error) : json({ ok: true }, 201);
  }

  // PATCH /api/templates/:id   DELETE /api/templates/:id
  const tplMatch = path.match(/^\/templates\/(\d+)$/);
  if (method === 'PATCH' && tplMatch) {
    const id = parseInt(tplMatch[1]!, 10);
    const body = await req.json().catch(() => null);
    if (!body) return err('Missing body');
    for (const f of [
      'name',
      'role',
      'persona',
      'capabilities',
      'start_command',
    ] as const) {
      if (body[f] !== undefined) {
        const r = dbUpdateTemplate(id, f, String(body[f]));
        if (r.error) return err(r.error);
      }
    }
    return json({ ok: true });
  }
  if (method === 'DELETE' && tplMatch) {
    const id = parseInt(tplMatch[1]!, 10);
    const r = dbDeleteTemplate(id);
    return r.error ? err(r.error) : json({ ok: true });
  }

  // POST /api/agents/:name/send-input
  const sendInputMatch = path.match(/^\/agents\/([^/]+)\/send-input$/);
  if (method === 'POST' && sendInputMatch) {
    const name = decodeURIComponent(sendInputMatch[1]!);
    const agent = getAgent(name);
    if (!agent) return err('Agent not found', 404);
    if (!agent.tmux_target) return err('Agent has no pane', 400);
    const body = await req.json().catch(() => null);
    if (!body?.text) return err('Missing text');
    const { getQueue } = await import('../delivery/pane-queue.ts');
    await getQueue(agent.tmux_target).enqueue({
      type: 'paste',
      text: String(body.text),
    });
    return json({ ok: true });
  }

  // --- Room Templates CRUD ---

  // GET /api/room-templates
  if (method === 'GET' && path === '/room-templates')
    return json(getAllRoomTemplates());

  // POST /api/room-templates
  if (method === 'POST' && path === '/room-templates') {
    const body = await req.json().catch(() => null);
    if (!body?.name) return err('Missing name');
    const ids = Array.isArray(body.agentTemplateIds)
      ? body.agentTemplateIds
      : [];
    const r = dbCreateRoomTemplate(body.name, body.topic ?? null, ids);
    return r.error ? err(r.error) : json({ ok: true }, 201);
  }

  // PATCH/DELETE /api/room-templates/:id
  const roomTplMatch = path.match(/^\/room-templates\/(\d+)$/);
  if (method === 'PATCH' && roomTplMatch) {
    const id = parseInt(roomTplMatch[1]!, 10);
    const body = await req.json().catch(() => null);
    if (!body) return err('Missing body');
    for (const f of ['name', 'topic', 'agent_template_ids'] as const) {
      if (body[f] !== undefined) {
        const val =
          f === 'agent_template_ids'
            ? JSON.stringify(body[f])
            : (body[f] ?? '');
        const r = dbUpdateRoomTemplate(id, f, String(val));
        if (r.error) return err(r.error);
      }
    }
    return json({ ok: true });
  }
  if (method === 'DELETE' && roomTplMatch) {
    const id = parseInt(roomTplMatch[1]!, 10);
    const r = dbDeleteRoomTemplate(id);
    return r.error ? err(r.error) : json({ ok: true });
  }

  // POST /api/rooms/:name/onboard-agent
  const onboardAgentMatch = path.match(/^\/rooms\/([^/]+)\/onboard-agent$/);
  if (method === 'POST' && onboardAgentMatch) {
    const roomName = decodeURIComponent(onboardAgentMatch[1]!);
    const room = getRoom(roomName);
    if (!room) return err('Room not found', 404);

    const body = await req.json().catch(() => null);
    if (!body?.templateId) return err('Missing templateId');
    const templateId = Number(body.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0)
      return err('Invalid templateId');

    const template = getAgentTemplateById(templateId);
    if (!template) return err('Agent template not found', 404);

    const members = getRoomMembers(room.id).filter((m) => !!m.tmux_target);
    if (members.length === 0) return err('No tmux agents in room', 400);

    const {
      getPaneSessionName,
      splitPaneInWindow,
      listSessionWindows,
      sendKeys,
      killPane,
    } = await import('../tmux/index.ts');

    const basePane = members[0]!.tmux_target!;
    const sessionName = await getPaneSessionName(basePane);
    if (!sessionName) return err('Could not resolve tmux session', 400);

    const windows = await listSessionWindows(sessionName).catch(() => null);
    if (!windows || windows.length === 0)
      return err('No tmux windows found', 400);

    let targetWindowIndex: number | null = null;
    if (body.windowIndex !== undefined && body.windowIndex !== null) {
      const parsedWindow = Number(body.windowIndex);
      if (!Number.isInteger(parsedWindow)) return err('Invalid windowIndex');
      targetWindowIndex = parsedWindow;
    } else {
      targetWindowIndex =
        windows.find((window) => window.active)?.index ?? null;
    }
    if (targetWindowIndex === null)
      return err('Could not resolve target window', 400);

    const window = windows.find((w) => w.index === targetWindowIndex);
    if (!window) return err('Window not found', 400);

    let finalName =
      (typeof body.name === 'string' && body.name.trim()) || template.name;
    while (getAgentByRoomAndName(room.id, finalName)) {
      finalName = `${finalName}-${randomSuffix()}`;
    }

    const paneId = await splitPaneInWindow(
      sessionName,
      targetWindowIndex,
      room.path,
    ).catch(() => null);
    if (!paneId) return err('Failed to create pane in target window', 400);

    const cmd = template.start_command || 'claude';
    const sendResult = await sendKeys(paneId, cmd);
    if (!sendResult.delivered) {
      await killPane(paneId).catch(() => undefined);
      return err(`start_failed: ${sendResult.error ?? 'unknown error'}`, 400);
    }

    const { getQueue } = await import('../delivery/pane-queue.ts');
    try {
      await getQueue(paneId, { role: template.role }).enqueue({
        type: 'paste',
        text: `crew join --room ${shellQuote(roomName)} --role ${shellQuote(template.role)} --name ${shellQuote(finalName)}`,
      });
    } catch {
      await killPane(paneId).catch(() => undefined);
      return err('Failed to send join command', 400);
    }

    return json(
      {
        ok: true,
        room: roomName,
        target_window: { index: window.index, name: window.name },
        agent: {
          name: finalName,
          role: template.role,
          pane: paneId,
          status: 'started',
        },
      },
      201,
    );
  }

  // POST /api/room-templates/:id/onboard
  const onboardMatch = path.match(/^\/room-templates\/(\d+)\/onboard$/);
  if (method === 'POST' && onboardMatch) {
    const body = await req.json().catch(() => null);
    if (!body?.name) return err('Missing name');
    if (!body?.path) return err('Missing path');
    if (/\s/.test(body.name)) return err('Room name must not contain spaces');
    if (body.name.length > 32)
      return err('Room name must be 32 characters or fewer');
    const templateId = parseInt(onboardMatch[1]!, 10);
    const tplDef = getRoomTemplateDefinition(templateId);
    if (!tplDef) return err('Room template not found', 404);

    // Validate and normalize path
    const { realpathSync, existsSync } = await import('fs');
    if (!existsSync(body.path)) return err('Path does not exist');
    const normalizedPath = realpathSync(body.path);

    // Resolve agent templates
    const agentTpls = tplDef.agent_template_ids
      .map((id: number) => getAgentTemplateById(id))
      .filter(Boolean) as Array<{
      id: number;
      name: string;
      role: string;
      start_command?: string;
    }>;
    if (agentTpls.length === 0)
      return err('No agent templates in this room template');

    // Check room name collision
    const roomName = body.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const existingRoom = getRoom(roomName);
    if (existingRoom) return err(`Room "${roomName}" already exists`);

    // Create room with real path
    const createResult = dbCreateRoom(
      roomName,
      tplDef.topic ?? undefined,
      tplDef.agent_template_ids,
      normalizedPath,
    );
    if (createResult.error) return err(createResult.error);

    // Create tmux session — kill existing session if name collides
    const { createSession, splitPane, sendKeys, killSession } = await import(
      '../tmux/index.ts'
    );
    await killSession(roomName);
    const paneIds: string[] = [];
    try {
      const firstPane = await createSession(roomName, normalizedPath);
      paneIds.push(firstPane);
      for (let i = 1; i < agentTpls.length; i++) {
        const paneId = await splitPane(firstPane, normalizedPath);
        paneIds.push(paneId);
      }
    } catch (e) {
      return err(
        `tmux setup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Launch agents and send join commands
    const { getQueue } = await import('../delivery/pane-queue.ts');
    const results: Array<{
      name: string;
      role: string;
      pane: string;
      status: string;
    }> = [];

    for (let i = 0; i < agentTpls.length; i++) {
      const at = agentTpls[i]!;
      const paneId = paneIds[i]!;
      const cmd = at.start_command || 'claude';

      try {
        // Send start command
        const sendResult = await sendKeys(paneId, cmd);
        if (!sendResult.delivered) {
          results.push({
            name: at.name,
            role: at.role,
            pane: paneId,
            status: `start_failed: ${sendResult.error}`,
          });
          continue;
        }

        // Wait for agent to become idle, then send join command
        const queue = getQueue(paneId, { role: at.role });
        await queue.enqueue({
          type: 'paste',
          text: `crew join --room ${roomName} --role ${at.role} --name ${at.name}`,
        });

        results.push({
          name: at.name,
          role: at.role,
          pane: paneId,
          status: 'started',
        });
      } catch (e) {
        results.push({
          name: at.name,
          role: at.role,
          pane: paneId,
          status: `error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    return json({ ok: true, room: roomName, agents: results }, 201);
  }

  return err('Not found', 404);
}
