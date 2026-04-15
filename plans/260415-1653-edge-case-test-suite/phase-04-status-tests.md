# Phase 4: Status Detection Tests (E6-E8)

**Status:** Pending  
**Priority:** High  
**Effort:** 30 min

---

## Overview

Test status pattern matching edge cases: unstable content, busy timeout, buried status lines.

---

## Tests

### E6: Unknown + constantly changing content

```typescript
async function testE6_UnstableContent() {
  console.log('\nE6: Unknown status with unstable content');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e6-agent');
  await Bun.sleep(500);
  await setAgentMode('e6-agent', 'chaos'); // rapidly changing output
  
  // Import the function we're testing
  const { PaneQueue } = await import('../../src/delivery/pane-queue.ts');
  const queue = new PaneQueue(pane);
  
  // waitForReady should NOT return until content stabilizes
  // In chaos mode, it should timeout (MAX_WAIT_MS = 10s)
  const start = Date.now();
  
  // Queue a message - it should wait for stability
  const deliveryPromise = queue.enqueue({ type: 'paste', text: 'test' });
  
  // After 2s, switch to idle to let it stabilize
  setTimeout(() => setAgentMode('e6-agent', 'idle'), 2000);
  
  await deliveryPromise;
  const elapsed = Date.now() - start;
  
  assert(elapsed >= 2000, `Waited for stability (${elapsed}ms >= 2000ms)`);
  assert(elapsed < 10000, `Delivered before timeout (${elapsed}ms < 10000ms)`);
}
```

### E7: Busy timeout

```typescript
async function testE7_BusyTimeout() {
  console.log('\nE7: Busy status timeout');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e7-agent');
  await Bun.sleep(500);
  await setAgentMode('e7-agent', 'busy'); // perpetually busy
  
  const { PaneQueue } = await import('../../src/delivery/pane-queue.ts');
  const queue = new PaneQueue(pane);
  
  const start = Date.now();
  await queue.enqueue({ type: 'paste', text: 'message to busy agent' });
  const elapsed = Date.now() - start;
  
  // Should timeout at MAX_WAIT_MS (10s) and deliver anyway
  assert(elapsed >= 9000, `Waited near timeout (${elapsed}ms >= 9000ms)`);
  assert(elapsed <= 12000, `Didn't hang forever (${elapsed}ms <= 12000ms)`);
  
  // Verify message was delivered despite busy status
  const content = await capturePane(pane);
  assert(content.includes('message to busy agent'), 'Message delivered after timeout');
}
```

### E8: Status line buried under output

```typescript
async function testE8_BuriedStatus() {
  console.log('\nE8: Status buried under verbose output');
  
  const pane = await createTestPane('bash -c "for i in {1..200}; do echo line-$i; done; echo ❯"');
  await Bun.sleep(1000); // let output complete
  
  // Import status matcher
  const { matchStatusLine } = await import('../../src/shared/status-patterns.ts');
  const { capturePane: tmuxCapture } = await import('../../src/tmux/index.ts');
  
  const content = await tmuxCapture(pane);
  const status = matchStatusLine(content || '');
  
  // Status line is at bottom, should still be detected
  assert(status === 'idle', `Detected idle despite 200 lines above (got: ${status})`);
}
```

---

## Acceptance Criteria

- [ ] E6: Chaos mode delays delivery until stable
- [ ] E7: Busy timeout triggers at ~10s, delivers anyway
- [ ] E8: Status detected even with 200 lines above
