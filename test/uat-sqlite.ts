#!/usr/bin/env bun
/**
 * UAT: Real end-to-end test with live tmux panes.
 * Reproduces the original bug: leader should see BOTH workers' completions.
 *
 * Usage: bun test/uat-sqlite.ts
 */
import { initDb, closeDb } from '../src/state/db.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleLeaveRoom } from '../src/tools/leave-room.ts';
import { handleListRooms } from '../src/tools/list-rooms.ts';
import { handleListMembers } from '../src/tools/list-members.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import { handleReadMessages } from '../src/tools/read-messages.ts';
import { handleGetStatus } from '../src/tools/get-status.ts';
import { handleSetRoomTopic } from '../src/tools/set-room-topic.ts';
import { handleRefresh } from '../src/tools/refresh.ts';
import { Database } from 'bun:sqlite';

const SESSION = 'uat-sqlite';
const PANES: string[] = [];
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function createPane(name: string): Promise<string> {
  if (PANES.length === 0) {
    // Create session with first pane
    const p = Bun.spawn(['tmux', 'new-session', '-d', '-s', SESSION, '-n', name, '-P', '-F', '#{pane_id}'], { stdout: 'pipe' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const pane = out.trim();
    PANES.push(pane);
    return pane;
  }
  // Add pane to existing session
  const p = Bun.spawn(['tmux', 'split-window', '-t', SESSION, '-P', '-F', '#{pane_id}'], { stdout: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const pane = out.trim();
  PANES.push(pane);
  return pane;
}

async function capturePaneText(pane: string): Promise<string> {
  const p = Bun.spawn(['tmux', 'capture-pane', '-p', '-J', '-t', pane, '-S', '-50'], { stdout: 'pipe' });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return text;
}

async function cleanup() {
  try {
    const p = Bun.spawn(['tmux', 'kill-session', '-t', SESSION], { stdout: 'pipe', stderr: 'pipe' });
    await p.exited;
  } catch { /* ignore */ }
  closeDb();
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

// ─── MAIN ───

console.log('\n═══ crew SQLite UAT ═══\n');

// Clean up any leftover session
await cleanup();

// Init DB with a temp file (not :memory:) to test real file-based SQLite
const dbPath = '/tmp/crew/uat-test/crew.db';
await Bun.spawn(['rm', '-rf', '/tmp/crew/uat-test']).exited;
await Bun.spawn(['mkdir', '-p', '/tmp/crew/uat-test']).exited;
initDb(dbPath);

try {
  // ─── 1. Create real tmux panes ───
  console.log('1. Creating tmux panes...');
  const bossPane = await createPane('boss');
  const leaderPane = await createPane('leader');
  const worker1Pane = await createPane('worker1');
  const worker2Pane = await createPane('worker2');
  assert(PANES.length === 4, `Created 4 panes: ${PANES.join(', ')}`);

  // ─── 2. Agents join rooms ───
  console.log('\n2. Agents joining rooms...');

  let r = await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: bossPane });
  assert(!r.isError, 'boss-1 joined company', r.isError ? parse(r).error : undefined);

  r = await handleJoinRoom({ room: 'company', role: 'leader', name: 'lead-1', tmux_target: leaderPane });
  assert(!r.isError, 'lead-1 joined company');

  r = await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: leaderPane });
  assert(!r.isError, 'lead-1 joined frontend (multi-room)');

  r = await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'w1', tmux_target: worker1Pane });
  assert(!r.isError, 'w1 joined frontend');

  r = await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'w2', tmux_target: worker2Pane });
  assert(!r.isError, 'w2 joined frontend');

  // ─── 3. Verify room state ───
  console.log('\n3. Verifying room state...');

  r = await handleListRooms();
  const rooms = parse(r);
  assert(rooms.rooms.length === 2, `2 rooms exist: ${rooms.rooms.map((r: any) => r.name).join(', ')}`);

  const frontendRoom = rooms.rooms.find((r: any) => r.name === 'frontend');
  assert(frontendRoom?.member_count === 3, `frontend has 3 members (got ${frontendRoom?.member_count})`);

  r = await handleListMembers({ room: 'frontend' });
  const members = parse(r);
  const memberNames = members.members.map((m: any) => m.name).sort();
  assert(JSON.stringify(memberNames) === '["lead-1","w1","w2"]', `frontend members: ${memberNames.join(', ')}`);

  // ─── 4. Set room topic ───
  console.log('\n4. Setting room topic...');

  r = await handleSetRoomTopic({ room: 'frontend', text: 'Build auth system', name: 'lead-1' });
  assert(!r.isError, 'Topic set on frontend');

  r = await handleListMembers({ room: 'frontend' });
  const topicData = parse(r);
  assert(topicData.topic === 'Build auth system', `Topic reads back: "${topicData.topic}"`);

  // ─── 5. Leader delegates tasks to workers ───
  console.log('\n5. Leader delegates tasks...');

  r = await handleSendMessage({
    room: 'frontend', text: 'Build login page', to: 'w1',
    name: 'lead-1', kind: 'task',
  });
  assert(!r.isError, 'Task sent to w1');
  const taskW1 = parse(r);
  assert(taskW1.delivered === true, 'Task delivered to w1 pane');

  r = await handleSendMessage({
    room: 'frontend', text: 'Build signup page', to: 'w2',
    name: 'lead-1', kind: 'task',
  });
  assert(!r.isError, 'Task sent to w2');
  const taskW2 = parse(r);
  assert(taskW2.delivered === true, 'Task delivered to w2 pane');

  // ─── 6. Verify workers received tasks ───
  console.log('\n6. Workers read their tasks...');

  r = await handleReadMessages({ name: 'w1', room: 'frontend' });
  const w1Msgs = parse(r);
  assert(w1Msgs.messages.length >= 1, `w1 sees ${w1Msgs.messages.length} message(s)`);
  const w1Task = w1Msgs.messages.find((m: any) => m.kind === 'task');
  assert(w1Task?.text === 'Build login page', `w1 task: "${w1Task?.text}"`);

  r = await handleReadMessages({ name: 'w2', room: 'frontend' });
  const w2Msgs = parse(r);
  assert(w2Msgs.messages.length >= 1, `w2 sees ${w2Msgs.messages.length} message(s)`);
  // Room log shows ALL room messages; find w2's specific task (sent to w2)
  const w2Task = w2Msgs.messages.find((m: any) => m.kind === 'task' && m.to === 'w2');
  assert(w2Task?.text === 'Build signup page', `w2 task: "${w2Task?.text}"`);

  // ─── 7. THE ORIGINAL BUG SCENARIO ───
  // Both workers complete their tasks, leader should see BOTH
  console.log('\n7. ★ ORIGINAL BUG SCENARIO: Both workers complete...');

  r = await handleSendMessage({
    room: 'frontend', text: 'Login page done', to: 'lead-1',
    name: 'w1', mode: 'pull', kind: 'completion',
  });
  assert(!r.isError, 'w1 sent completion');

  r = await handleSendMessage({
    room: 'frontend', text: 'Signup page done', to: 'lead-1',
    name: 'w2', mode: 'pull', kind: 'completion',
  });
  assert(!r.isError, 'w2 sent completion');

  // Leader reads completions — THIS IS THE BUG TEST
  r = await handleReadMessages({ name: 'lead-1', room: 'frontend', kinds: ['completion'] });
  const completions = parse(r);
  assert(completions.messages.length === 2,
    `Leader sees ${completions.messages.length} completions (expected 2)`,
    completions.messages.length !== 2 ? `Only got: ${completions.messages.map((m: any) => m.text).join(', ')}` : undefined,
  );

  const completionTexts = completions.messages.map((m: any) => m.text).sort();
  assert(completionTexts.includes('Login page done'), 'Leader sees w1 completion');
  assert(completionTexts.includes('Signup page done'), 'Leader sees w2 completion');

  // ─── 8. Verify push delivery in tmux panes ───
  console.log('\n8. Verifying tmux pane delivery...');
  await Bun.sleep(300); // wait for tmux send-keys to land

  const w1PaneText = await capturePaneText(worker1Pane);
  assert(w1PaneText.includes('Build login page'), `w1 pane contains task text`);

  const w2PaneText = await capturePaneText(worker2Pane);
  assert(w2PaneText.includes('Build signup page'), `w2 pane contains task text`);

  // Auto-notify: leader should get system notifications in pane
  const leaderPaneText = await capturePaneText(leaderPane);
  assert(leaderPaneText.includes('[system@frontend]'), 'Leader pane has system notification');
  assert(leaderPaneText.includes('w1') && leaderPaneText.includes('completion'), 'Leader pane notified of w1 completion');
  assert(leaderPaneText.includes('w2') && leaderPaneText.includes('completion'), 'Leader pane notified of w2 completion');

  // ─── 9. Broadcast message ───
  console.log('\n9. Testing broadcast...');

  r = await handleSendMessage({
    room: 'frontend', text: 'Great work team!', name: 'lead-1',
  });
  assert(!r.isError, 'Broadcast sent');
  const broadcast = parse(r);
  assert(broadcast.broadcast === true, 'Response indicates broadcast');
  assert(broadcast.recipients === 2, `Broadcast reached ${broadcast.recipients} recipients (expected 2)`);

  // Workers should see broadcast
  r = await handleReadMessages({ name: 'w1', room: 'frontend' });
  const w1After = parse(r);
  const broadcastMsg = w1After.messages.find((m: any) => m.text === 'Great work team!');
  assert(broadcastMsg !== undefined, 'w1 sees broadcast in room log');

  // ─── 10. Verify SQLite DB directly ───
  console.log('\n10. Verifying SQLite DB directly...');

  const db = new Database(dbPath, { readonly: true });

  const agentCount = (db.query('SELECT COUNT(*) as c FROM agents').get() as any).c;
  assert(agentCount === 4, `DB has ${agentCount} agents (expected 4)`);

  const roomCount = (db.query('SELECT COUNT(*) as c FROM rooms').get() as any).c;
  assert(roomCount === 2, `DB has ${roomCount} rooms (expected 2)`);

  const msgCount = (db.query('SELECT COUNT(*) as c FROM messages').get() as any).c;
  assert(msgCount >= 6, `DB has ${msgCount} messages (expected >= 6)`);

  const completionMsgs = db.query("SELECT * FROM messages WHERE kind = 'completion'").all() as any[];
  assert(completionMsgs.length === 2, `DB has ${completionMsgs.length} completion messages`);
  const senders = completionMsgs.map((m: any) => m.sender).sort();
  assert(JSON.stringify(senders) === '["w1","w2"]', `Completion senders: ${senders.join(', ')}`);

  const topic = (db.query("SELECT topic FROM rooms WHERE name = 'frontend'").get() as any)?.topic;
  assert(topic === 'Build auth system', `DB room topic: "${topic}"`);

  db.close();

  // ─── 11. Dashboard state reader ───
  console.log('\n11. Testing dashboard state reader...');

  // The StateReader from dashboard should be able to read this DB
  process.env.CC_TMUX_STATE_DIR = '/tmp/crew/uat-test';
  const { StateReader } = await import('../src/dashboard/state-reader.ts');
  const reader = new StateReader();
  const state = await reader.init();

  assert(reader.isAvailable, 'Dashboard state reader found DB');
  assert(Object.keys(state.agents).length === 4, `Dashboard sees ${Object.keys(state.agents).length} agents`);
  assert(Object.keys(state.rooms).length === 2, `Dashboard sees ${Object.keys(state.rooms).length} rooms`);
  assert(state.messages.length >= 6, `Dashboard sees ${state.messages.length} messages`);

  // Verify agent details
  const dashLead = state.agents['lead-1'];
  assert(dashLead?.rooms.includes('company') && dashLead?.rooms.includes('frontend'),
    `Dashboard shows lead-1 in rooms: ${dashLead?.rooms.join(', ')}`);
  assert(dashLead?.tmux_target === leaderPane, `Dashboard shows correct pane: ${dashLead?.tmux_target}`);

  // Verify room topic
  const dashFrontend = state.rooms['frontend'];
  assert(dashFrontend?.topic === 'Build auth system', `Dashboard shows topic: "${dashFrontend?.topic}"`);

  reader.stop();

  // ─── 12. Refresh (simulate session resume) ───
  console.log('\n12. Testing refresh...');

  // w2 "resumes" on a different pane — refresh should update pane but keep rooms
  const oldW2Pane = worker2Pane;
  r = await handleRefresh({ name: 'w2', tmux_target: worker1Pane });
  assert(!r.isError, 'w2 refresh succeeded');
  const refreshed = parse(r);
  assert(refreshed.rooms.includes('frontend'), `Refreshed w2 still in frontend`);
  assert(refreshed.tmux_target === worker1Pane, `w2 pane updated to ${worker1Pane}`);

  // Refresh back to original pane
  await handleRefresh({ name: 'w2', tmux_target: oldW2Pane });

  // Refresh unknown agent
  r = await handleRefresh({ name: 'ghost', tmux_target: worker1Pane });
  assert(r.isError === true, 'Refresh unknown agent errors');

  // ─── 13. Leave room and cleanup ───
  console.log('\n13. Testing leave room...');

  r = await handleLeaveRoom({ room: 'frontend', name: 'w1' });
  assert(!r.isError, 'w1 left frontend');

  r = await handleListMembers({ room: 'frontend' });
  const afterLeave = parse(r);
  assert(afterLeave.members.length === 2, `frontend has ${afterLeave.members.length} members after w1 left`);
  assert(!afterLeave.members.find((m: any) => m.name === 'w1'), 'w1 no longer in frontend');

  // ─── 14. Get status (checks tmux pane) ───
  console.log('\n14. Testing get_status...');

  r = await handleGetStatus({ agent_name: 'lead-1' });
  assert(!r.isError, 'get_status for lead-1 succeeded');
  const status = parse(r);
  assert(['idle', 'busy', 'unknown'].includes(status.status), `lead-1 status: ${status.status}`);

} finally {
  // ─── Cleanup ───
  console.log('\n─── Cleanup ───');
  await cleanup();
  await Bun.spawn(['rm', '-rf', '/tmp/crew/uat-test']).exited;
}

// ─── Summary ───
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
