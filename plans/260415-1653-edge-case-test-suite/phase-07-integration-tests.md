# Phase 7: Integration Flow Tests (E14-E17)

**Status:** Pending  
**Priority:** Medium  
**Effort:** 40 min

---

## Overview

Test multi-agent coordination: stale detection, partial broadcast, notifications, concurrent sends.

---

## Tests

### E14: Stale pane (shell instead of agent)

```typescript
async function testE14_StalePaneDetection() {
  console.log('\nE14: Stale pane detection');
  
  // Create pane with plain bash (not our mock agent)
  const pane = await createTestPane('bash');
  await Bun.sleep(300);
  
  // Register agent pointing to this pane
  const { setupTestDb, teardownTestDb } = await import('./db-helpers.ts');
  const db = await setupTestDb();
  
  await db.run(`
    INSERT INTO agents (name, role, tmux_target, rooms, status, agent_type)
    VALUES ('stale-worker', 'worker', '${pane}', '["stale-room"]', 'idle', 'claude-code')
  `);
  await db.run(`
    INSERT INTO rooms (name, leader) VALUES ('stale-room', 'stale-leader')
  `);
  
  const { deliverMessage } = await import('../../src/delivery/index.ts');
  
  const results = await deliverMessage(
    'stale-leader',
    'stale-room',
    'task for stale worker',
    'stale-worker',
    'push',
    'task'
  );
  
  assert(results.length === 1, 'Got one result');
  assert(results[0].delivered === false, 'Delivery failed (stale detected)');
  assert(results[0].queued === true, 'Message still queued');
  assert(results[0].error?.includes('stale'), 'Error mentions stale');
  
  // Verify agent was marked stale
  const agent = db.query('SELECT status FROM agents WHERE name = ?').get('stale-worker');
  assert(agent?.status === 'stale', 'Agent marked as stale in DB');
  
  await teardownTestDb(db);
}
```

### E15: Broadcast with partial delivery

```typescript
async function testE15_BroadcastPartialDelivery() {
  console.log('\nE15: Broadcast with partial delivery');
  
  // Create 5 panes: 3 live, 2 dead
  const livePanes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const pane = await createTestPane(`bash crew/test/fixtures/mock-agent.sh live-${i}`);
    livePanes.push(pane);
  }
  await Bun.sleep(500);
  
  // Create 2 panes and kill them immediately
  const deadPanes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const pane = await createTestPane('bash');
    deadPanes.push(pane);
    await killPane(pane);
  }
  
  const { setupTestDb, teardownTestDb } = await import('./db-helpers.ts');
  const db = await setupTestDb();
  
  // Register all agents
  await db.run(`INSERT INTO rooms (name, leader) VALUES ('broadcast-room', 'broadcaster')`);
  
  for (let i = 0; i < 3; i++) {
    await db.run(`
      INSERT INTO agents (name, role, tmux_target, rooms, status, agent_type)
      VALUES ('live-${i}', 'worker', '${livePanes[i]}', '["broadcast-room"]', 'idle', 'claude-code')
    `);
  }
  for (let i = 0; i < 2; i++) {
    await db.run(`
      INSERT INTO agents (name, role, tmux_target, rooms, status, agent_type)
      VALUES ('dead-${i}', 'worker', '${deadPanes[i]}', '["broadcast-room"]', 'idle', 'claude-code')
    `);
  }
  
  const { deliverMessage } = await import('../../src/delivery/index.ts');
  
  const results = await deliverMessage(
    'broadcaster',
    'broadcast-room',
    'broadcast message',
    null, // broadcast
    'push',
    'chat'
  );
  
  const delivered = results.filter(r => r.delivered).length;
  const queued = results.filter(r => r.queued).length;
  
  assert(results.length === 5, `Broadcast to 5 recipients (got ${results.length})`);
  assert(delivered === 3, `3 delivered to live panes (got ${delivered})`);
  assert(queued === 5, `All 5 queued (got ${queued})`);
  
  await teardownTestDb(db);
}
```

### E16: Worker completion notifies leader

```typescript
async function testE16_WorkerNotifiesLeader() {
  console.log('\nE16: Worker completion notifies leader');
  
  const leaderPane = await createTestPane('bash crew/test/fixtures/mock-agent.sh test-leader');
  const workerPane = await createTestPane('bash crew/test/fixtures/mock-agent.sh test-worker');
  await Bun.sleep(500);
  
  const { setupTestDb, teardownTestDb } = await import('./db-helpers.ts');
  const db = await setupTestDb();
  
  await db.run(`INSERT INTO rooms (name, leader) VALUES ('notify-room', 'test-leader')`);
  await db.run(`
    INSERT INTO agents (name, role, tmux_target, rooms, status)
    VALUES ('test-leader', 'leader', '${leaderPane}', '["notify-room"]', 'idle')
  `);
  await db.run(`
    INSERT INTO agents (name, role, tmux_target, rooms, status)
    VALUES ('test-worker', 'worker', '${workerPane}', '["notify-room"]', 'idle')
  `);
  
  const { deliverMessage } = await import('../../src/delivery/index.ts');
  
  // Worker sends completion message
  await deliverMessage(
    'test-worker',
    'notify-room',
    'Task completed successfully',
    'test-leader',
    'push',
    'completion'
  );
  
  await Bun.sleep(1000);
  
  // Check leader pane for auto-notification
  const leaderContent = await capturePane(leaderPane);
  
  assert(leaderContent.includes('[system@notify-room]'), 'Leader received system notification');
  assert(leaderContent.includes('completion'), 'Notification mentions completion');
  
  await teardownTestDb(db);
}
```

### E17: Concurrent sends from 3 agents

```typescript
async function testE17_ConcurrentSends() {
  console.log('\nE17: Concurrent sends from 3 agents');
  
  const targetPane = await createTestPane('bash crew/test/fixtures/mock-agent.sh target');
  await Bun.sleep(500);
  
  const { setupTestDb, teardownTestDb } = await import('./db-helpers.ts');
  const db = await setupTestDb();
  
  await db.run(`INSERT INTO rooms (name, leader) VALUES ('concurrent-room', 'target')`);
  await db.run(`
    INSERT INTO agents (name, role, tmux_target, rooms, status)
    VALUES ('target', 'leader', '${targetPane}', '["concurrent-room"]', 'idle')
  `);
  
  for (let i = 1; i <= 3; i++) {
    await db.run(`
      INSERT INTO agents (name, role, tmux_target, rooms, status)
      VALUES ('sender-${i}', 'worker', '%${90+i}', '["concurrent-room"]', 'idle')
    `);
  }
  
  const { deliverMessage } = await import('../../src/delivery/index.ts');
  
  // Send 3 messages concurrently
  const promises = [1, 2, 3].map(i =>
    deliverMessage(
      `sender-${i}`,
      'concurrent-room',
      `CONCURRENT-MSG-${i}-MARKER`,
      'target',
      'push',
      'chat'
    )
  );
  
  const results = await Promise.all(promises);
  
  // All should succeed (mutex handles ordering)
  const allDelivered = results.every(r => r.length === 1 && r[0].delivered);
  assert(allDelivered, 'All 3 concurrent sends delivered');
  
  await Bun.sleep(1000);
  const content = await capturePane(targetPane);
  
  const found = [1, 2, 3].filter(i => content.includes(`CONCURRENT-MSG-${i}-MARKER`)).length;
  assert(found === 3, `All 3 messages in target pane (found ${found})`);
  
  await teardownTestDb(db);
}
```

---

## Acceptance Criteria

- [ ] E14: Shell-only pane detected as stale, agent marked
- [ ] E15: Broadcast reports delivered=3, queued=5
- [ ] E16: Worker completion triggers leader notification
- [ ] E17: 3 concurrent sends all succeed via mutex
