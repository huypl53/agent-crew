# Phase 6: Sender Verification Tests (E12-E13)

**Status:** Pending  
**Priority:** Medium  
**Effort:** 25 min

---

## Overview

Test sender verification with spoofed pane IDs and missing environment variables.

---

## Tests

### E12: Spoofed TMUX_PANE

```typescript
async function testE12_SpoofedPane() {
  console.log('\nE12: Spoofed TMUX_PANE');
  
  // This test needs to manipulate process.env and call handleSendMessage
  // We need a mock database with registered agents
  
  const { setupTestDb, teardownTestDb } = await import('./db-helpers.ts');
  const db = await setupTestDb();
  
  // Register an agent with pane %10
  await db.run(`
    INSERT INTO agents (name, role, tmux_target, rooms, status)
    VALUES ('test-worker', 'worker', '%10', '["test-room"]', 'idle')
  `);
  await db.run(`
    INSERT INTO rooms (name, leader) VALUES ('test-room', 'test-leader')
  `);
  
  // Save original env
  const originalPane = process.env.TMUX_PANE;
  const originalMode = process.env.CREW_SENDER_VERIFICATION;
  
  try {
    // Test LOG mode - should warn but allow
    process.env.CREW_SENDER_VERIFICATION = 'log';
    process.env.TMUX_PANE = '%99'; // spoofed - doesn't match %10
    
    const { handleSendMessage } = await import('../../src/tools/send-message.ts');
    
    // Capture console.warn
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    
    const logResult = await handleSendMessage({
      room: 'test-room',
      text: 'test message',
      name: 'test-worker',
      to: 'test-leader',
    });
    
    console.warn = origWarn;
    
    assert(logResult.ok === true, 'LOG mode: message allowed despite mismatch');
    assert(warnings.some(w => w.includes('mismatch')), 'LOG mode: warning logged');
    
    // Test ENFORCE mode - should reject
    process.env.CREW_SENDER_VERIFICATION = 'enforce';
    
    const enforceResult = await handleSendMessage({
      room: 'test-room',
      text: 'test message',
      name: 'test-worker',
      to: 'test-leader',
    });
    
    assert(enforceResult.ok === false, 'ENFORCE mode: message rejected');
    assert(enforceResult.error?.includes('mismatch'), 'ENFORCE mode: error mentions mismatch');
    
  } finally {
    // Restore env
    if (originalPane) process.env.TMUX_PANE = originalPane;
    else delete process.env.TMUX_PANE;
    if (originalMode) process.env.CREW_SENDER_VERIFICATION = originalMode;
    else delete process.env.CREW_SENDER_VERIFICATION;
    
    await teardownTestDb(db);
  }
}
```

### E13: No TMUX_PANE (external CLI)

```typescript
async function testE13_NoTmuxPane() {
  console.log('\nE13: No TMUX_PANE environment variable');
  
  const { setupTestDb, teardownTestDb } = await import('./db-helpers.ts');
  const db = await setupTestDb();
  
  await db.run(`
    INSERT INTO agents (name, role, tmux_target, rooms, status)
    VALUES ('cli-agent', 'worker', '%20', '["cli-room"]', 'idle')
  `);
  await db.run(`
    INSERT INTO rooms (name, leader) VALUES ('cli-room', 'cli-leader')
  `);
  
  const originalPane = process.env.TMUX_PANE;
  const originalMode = process.env.CREW_SENDER_VERIFICATION;
  
  try {
    // Remove TMUX_PANE - simulating external CLI call
    delete process.env.TMUX_PANE;
    process.env.CREW_SENDER_VERIFICATION = 'enforce';
    
    const { handleSendMessage } = await import('../../src/tools/send-message.ts');
    
    const result = await handleSendMessage({
      room: 'cli-room',
      text: 'external cli message',
      name: 'cli-agent',
      to: 'cli-leader',
    });
    
    // Should skip verification when no TMUX_PANE (can't verify)
    assert(result.ok === true, 'No TMUX_PANE: verification skipped, message allowed');
    
  } finally {
    if (originalPane) process.env.TMUX_PANE = originalPane;
    if (originalMode) process.env.CREW_SENDER_VERIFICATION = originalMode;
    else delete process.env.CREW_SENDER_VERIFICATION;
    
    await teardownTestDb(db);
  }
}
```

---

## Helper: db-helpers.ts

```typescript
// crew/test/lib/db-helpers.ts
import Database from 'bun:sqlite';

export async function setupTestDb(): Promise<Database> {
  const db = new Database(':memory:');
  // Run schema migrations
  // ... (import from src/state/schema.ts)
  return db;
}

export async function teardownTestDb(db: Database): Promise<void> {
  db.close();
}
```

---

## Acceptance Criteria

- [ ] E12 LOG: Spoofed pane logs warning, allows message
- [ ] E12 ENFORCE: Spoofed pane rejects message
- [ ] E13: Missing TMUX_PANE skips verification
