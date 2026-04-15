# Phase 5: Queue & Polling Tests (E9-E11)

**Status:** Pending  
**Priority:** Medium  
**Effort:** 30 min

---

## Overview

Test queue behavior under load and verify role-based polling intervals.

---

## Tests

### E9: Queue 20 messages

```typescript
async function testE9_QueueBacklog() {
  console.log('\nE9: Queue 20 messages');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e9-agent');
  await Bun.sleep(500);
  
  // Make agent slow (busy for 500ms per message)
  // We'll test that queue handles backlog correctly
  
  const { PaneQueue } = await import('../../src/delivery/pane-queue.ts');
  const queue = new PaneQueue(pane);
  
  const markers: string[] = [];
  const promises: Promise<void>[] = [];
  
  for (let i = 0; i < 20; i++) {
    const marker = `Q${i.toString().padStart(2, '0')}-MARKER`;
    markers.push(marker);
    promises.push(queue.enqueue({ type: 'paste', text: `Msg ${marker}` }));
  }
  
  // All should complete
  await Promise.all(promises);
  
  await Bun.sleep(1000);
  const content = await capturePane(pane, 300);
  
  // Count delivered
  let delivered = 0;
  for (const m of markers) {
    if (content.includes(m)) delivered++;
  }
  
  assert(delivered === 20, `All 20 queued messages delivered (got ${delivered})`);
  
  // Verify FIFO order
  let lastIdx = -1;
  let fifo = true;
  for (const m of markers) {
    const idx = content.indexOf(m);
    if (idx !== -1 && idx < lastIdx) fifo = false;
    if (idx !== -1) lastIdx = idx;
  }
  assert(fifo, 'Messages delivered in FIFO order');
}
```

### E10: Heartbeat stale fallback

```typescript
async function testE10_HeartbeatStaleFallback() {
  console.log('\nE10: Heartbeat stale fallback');
  
  const { getPollingInterval } = await import('../../src/delivery/pane-queue.ts');
  
  // Fresh activity (1 second ago)
  const freshInterval = getPollingInterval('worker', Date.now() - 1000);
  assert(freshInterval === 2000, `Fresh worker interval is 2000ms (got ${freshInterval})`);
  
  // Stale activity (35 seconds ago, > 30s threshold)
  const staleInterval = getPollingInterval('worker', Date.now() - 35000);
  assert(staleInterval === 500, `Stale worker falls back to 500ms (got ${staleInterval})`);
  
  // Very stale leader
  const staleLeaderInterval = getPollingInterval('leader', Date.now() - 60000);
  assert(staleLeaderInterval === 500, `Stale leader falls back to 500ms (got ${staleLeaderInterval})`);
}
```

### E11: Role-based polling intervals

```typescript
async function testE11_RoleBasedIntervals() {
  console.log('\nE11: Role-based polling intervals');
  
  const { getPollingInterval } = await import('../../src/delivery/pane-queue.ts');
  
  // With fresh activity
  const now = Date.now();
  
  const workerInterval = getPollingInterval('worker', now);
  assert(workerInterval === 2000, `Worker interval is 2000ms (got ${workerInterval})`);
  
  const leaderInterval = getPollingInterval('leader', now);
  assert(leaderInterval === 5000, `Leader interval is 5000ms (got ${leaderInterval})`);
  
  const bossInterval = getPollingInterval('boss', now);
  assert(bossInterval === 10000, `Boss interval is 10000ms (got ${bossInterval})`);
  
  // Unknown role defaults to worker
  const unknownInterval = getPollingInterval('unknown-role', now);
  assert(unknownInterval === 2000, `Unknown role defaults to 2000ms (got ${unknownInterval})`);
  
  // No role defaults to worker
  const noRoleInterval = getPollingInterval(undefined, now);
  assert(noRoleInterval === 2000, `No role defaults to 2000ms (got ${noRoleInterval})`);
}
```

---

## Acceptance Criteria

- [ ] E9: 20 queued messages delivered in FIFO order
- [ ] E10: Stale heartbeat (>30s) triggers 500ms fallback
- [ ] E11: worker=2s, leader=5s, boss=10s intervals
