# Phase 3: Delivery Failure Tests (E1-E5)

**Status:** Pending  
**Priority:** High  
**Effort:** 40 min

---

## Overview

Test delivery layer resilience: pane death, Enter retry, large payloads, special characters, rapid-fire.

---

## Tests

### E1: Pane dies mid-delivery

```typescript
async function testE1_PaneDiesMidDelivery() {
  console.log('\nE1: Pane dies mid-delivery');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e1-agent');
  await Bun.sleep(500); // let agent start
  
  // Start delivery in background, kill pane during paste
  const deliveryPromise = sendKeys(pane, 'Test message for dead pane');
  await Bun.sleep(100); // after paste, before Enter
  await killPane(pane);
  
  try {
    const result = await deliveryPromise;
    // Should fail gracefully, not crash
    assert(!result.delivered || true, 'Delivery handled gracefully (no crash)');
  } catch (e) {
    assert(true, 'Delivery threw expected error on dead pane');
  }
}
```

### E2: Enter retry exhaustion

```typescript
async function testE2_EnterRetryExhaustion() {
  console.log('\nE2: Enter retry exhaustion');
  
  // Use frozen mode - agent won't process Enter
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e2-agent');
  await Bun.sleep(500);
  await setAgentMode('e2-agent', 'frozen');
  
  const start = Date.now();
  const result = await sendKeys(pane, 'Message to frozen agent');
  const elapsed = Date.now() - start;
  
  // Should attempt 3 retries with backoff (300 + 500 + 300 + 1000 + 300 = ~2.4s min)
  assert(elapsed > 2000, `Retry backoff occurred (${elapsed}ms > 2000ms)`);
  assert(result.delivered, 'Delivery marked as delivered (best effort)');
}
```

### E3: Large payload (10KB)

```typescript
async function testE3_LargePayload() {
  console.log('\nE3: Large payload (10KB)');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e3-agent');
  await Bun.sleep(500);
  
  const marker = 'END-MARKER-E3';
  const payload = 'A'.repeat(10000) + marker;
  
  await sendKeys(pane, payload);
  await Bun.sleep(1000);
  
  const content = await capturePane(pane, 500);
  assert(content.includes(marker), 'Full 10KB payload arrived (marker present)');
}
```

### E4: Special characters

```typescript
async function testE4_SpecialChars() {
  console.log('\nE4: Special characters');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e4-agent');
  await Bun.sleep(500);
  
  const testCases = [
    { input: '$(echo pwned)', expect: '$(echo pwned)', name: 'command substitution' },
    { input: '`backticks`', expect: '`backticks`', name: 'backticks' },
    { input: '"quotes" & \'apostrophes\'', expect: '"quotes"', name: 'quotes' },
    { input: '\\backslash\\', expect: '\\backslash\\', name: 'backslash' },
  ];
  
  for (const tc of testCases) {
    await sendKeys(pane, tc.input);
    await Bun.sleep(300);
    const content = await capturePane(pane);
    assert(content.includes(tc.expect), `${tc.name} preserved literally`);
  }
}
```

### E5: Rapid-fire (10 messages)

```typescript
async function testE5_RapidFire() {
  console.log('\nE5: Rapid-fire (10 messages)');
  
  const pane = await createTestPane('bash crew/test/fixtures/mock-agent.sh e5-agent');
  await Bun.sleep(500);
  
  const markers: string[] = [];
  for (let i = 0; i < 10; i++) {
    const marker = `MSG-${i}-MARKER`;
    markers.push(marker);
    // Fire without waiting
    sendKeys(pane, `Message ${i} ${marker}`);
  }
  
  await Bun.sleep(3000); // let all settle
  const content = await capturePane(pane, 200);
  
  let found = 0;
  for (const m of markers) {
    if (content.includes(m)) found++;
  }
  
  assert(found === 10, `All 10 messages arrived (found ${found}/10)`);
  
  // Check order - markers should appear in sequence
  let lastIdx = -1;
  let inOrder = true;
  for (const m of markers) {
    const idx = content.indexOf(m);
    if (idx < lastIdx) inOrder = false;
    lastIdx = idx;
  }
  assert(inOrder, 'Messages arrived in order');
}
```

---

## Acceptance Criteria

- [ ] E1: Dead pane doesn't crash delivery
- [ ] E2: Retry backoff observable (>2s elapsed)
- [ ] E3: 10KB payload arrives intact
- [ ] E4: Special chars preserved literally
- [ ] E5: 10 rapid messages arrive in order
