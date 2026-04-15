# Phase 1: Isolated Test Harness

**Status:** Pending  
**Priority:** High  
**Effort:** 30 min

---

## Overview

Create test harness using isolated tmux socket (`tmux -L crew-uat-edge`) to avoid interference with user's real tmux session.

---

## File to Create

`crew/test/lib/edge-test-harness.ts`

---

## Implementation

```typescript
const SOCKET_NAME = 'crew-uat-edge';
const SESSION_NAME = 'edge-tests';

// Run tmux command on isolated socket
async function runTmux(...args: string[]): Promise<{ stdout: string; success: boolean }> {
  const proc = Bun.spawn(['tmux', '-L', SOCKET_NAME, ...args], {
    stdout: 'pipe', stderr: 'pipe'
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { stdout: stdout.trimEnd(), success: code === 0 };
}

// Initialize isolated tmux server + session
export async function setupEdgeTestEnv(): Promise<void> {
  await cleanupEdgeTestEnv(); // clean any leftover
  await runTmux('new-session', '-d', '-s', SESSION_NAME, '-x', '200', '-y', '50');
}

// Kill entire isolated tmux server
export async function cleanupEdgeTestEnv(): Promise<void> {
  await runTmux('kill-server').catch(() => {});
}

// Create pane in isolated session, optionally run command
export async function createTestPane(cmd?: string): Promise<string> {
  const args = ['split-window', '-t', SESSION_NAME, '-P', '-F', '#{pane_id}'];
  if (cmd) args.push(cmd);
  const result = await runTmux(...args);
  return result.stdout;
}

// Kill specific pane
export async function killPane(paneId: string): Promise<void> {
  await runTmux('kill-pane', '-t', paneId);
}

// Capture pane content
export async function capturePane(paneId: string, lines = 50): Promise<string> {
  const result = await runTmux('capture-pane', '-t', paneId, '-p', '-S', `-${lines}`);
  return result.stdout;
}

// Send keys to pane (for direct tmux testing, not crew delivery)
export async function sendKeys(paneId: string, text: string): Promise<void> {
  await runTmux('send-keys', '-t', paneId, '-l', text);
  await runTmux('send-keys', '-t', paneId, 'Enter');
}

// Set mock agent mode via control file
export async function setAgentMode(agentName: string, mode: 'idle' | 'busy' | 'dead' | 'chaos'): Promise<void> {
  await Bun.write(`/tmp/crew-mock-${agentName}.mode`, mode);
}

// Assert helper
export function assert(condition: boolean, label: string, detail?: string): { passed: boolean } {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return { passed: true };
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    return { passed: false };
  }
}
```

---

## Key Design Decisions

1. **Socket name**: `crew-uat-edge` — unique, won't collide with user sessions
2. **Cleanup**: `kill-server` on isolated socket kills everything cleanly
3. **Control files**: `/tmp/crew-mock-{name}.mode` for dynamic mode switching
4. **Assert helper**: Simple pass/fail with optional detail on failure

---

## Acceptance Criteria

- [ ] `setupEdgeTestEnv()` creates isolated tmux server
- [ ] `cleanupEdgeTestEnv()` destroys it completely
- [ ] `createTestPane()` returns valid pane ID
- [ ] No interference with user's default tmux server
