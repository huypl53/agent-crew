
# Token Usage Tracking — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-agent token usage and cost for Claude Code and Codex CLI agents, displayed in the crew dashboard.

**Architecture:** Passive collection via two sources: (1) Claude Code status line JSON parsed through a statusline command that writes to a known location, with JSONL parsing as fallback; (2) Codex CLI's local SQLite DB (`~/.codex/state_5.sqlite`). Data stored in new `token_usage` and `pricing` tables, polled every 30s, displayed in dashboard HeaderStats, DetailsPanel, and TreePanel.

**Tech Stack:** TypeScript, Bun, SQLite, React Ink (dashboard)

---

## File Structure

### New Files
- `src/tokens/collector.ts` — Main token collection loop (30s interval), orchestrates Claude Code + Codex collection
- `src/tokens/claude-code.ts` — Claude Code token extraction: reads statusline JSON files from /tmp/crew/tokens/, falls back to JSONL parsing via PID mapping chain
- `src/tokens/codex.ts` — Codex token extraction: reads ~/.codex/state_5.sqlite threads table
- `src/tokens/pricing.ts` — Pricing lookup and cost calculation for Codex (Claude Code provides cost directly)
- `src/tokens/pid-mapper.ts` — Maps tmux pane → shell PID → claude PID → session file → JSONL path
- `test/tokens.test.ts` — Unit tests for token collection, pricing, PID mapping
- `data/default-pricing.json` — Default model pricing (gpt-4.1, o3, o4-mini, claude-sonnet-4-6, claude-opus-4-6)

### Modified Files
- `src/state/db.ts` — Add `token_usage` and `pricing` tables to SCHEMA
- `src/state/index.ts` — Add token_usage and pricing CRUD functions
- `src/index.ts` — Start token collection loop on server init
- `src/dashboard/hooks/useStateReader.ts` — Add token_usage to DashboardState, query in readAll()
- `src/dashboard/App.tsx` — Pass tokenUsage to components
- `src/dashboard/components/HeaderStats.tsx` — Show total crew cost
- `src/dashboard/components/DetailsPanel.tsx` — Show per-agent cost/tokens in agent detail view
- `src/dashboard/components/TreePanel.tsx` — Show inline cost per agent
- `src/shared/types.ts` — Add TokenUsage and PricingEntry types

---

## Chunk 1: Schema, Types & Pricing Foundation

### Task 1: Add Types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add TokenUsage and PricingEntry types**

Add at the end of the file:

```ts
/* ── Token tracking ─────────────────────────────────────── */

export interface TokenUsage {
  id: number;
  agent_name: string;
  session_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  source: 'statusline' | 'jsonl' | 'codex_db';
  recorded_at: string;
}

export interface PricingEntry {
  model_name: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
}
```

- [ ] **Step 2: Verify no type errors**

Run: `bun build src/shared/types.ts --no-bundle`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m \"feat: add TokenUsage and PricingEntry types\"
```

---

### Task 2: Add token_usage and pricing Tables to Schema

**Files:**
- Modify: `src/state/db.ts`
- Test: `test/state.test.ts`

- [ ] **Step 1: Write failing test**

Add to test/state.test.ts:

```ts
import { getDb } from '../src/state/db.ts';

describe('token_usage table', () => {
  test('token_usage table exists', () => {
    const db = getDb();
    const row = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'\").get();
    expect(row).toBeTruthy();
  });

  test('pricing table exists with defaults', () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM pricing').all();
    expect(rows.length).toBeGreaterThan(0);
    const models = rows.map((r: any) => r.model_name);
    expect(models).toContain('claude-opus-4-6');
    expect(models).toContain('gpt-4.1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/state.test.ts`
Expected: FAIL — no such table: token_usage

- [ ] **Step 3: Add tables to SCHEMA in db.ts**

Add before the CREATE INDEX statements:

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name  TEXT NOT NULL,
  session_id  TEXT,
  model       TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL,
  source      TEXT NOT NULL DEFAULT 'statusline',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pricing (
  model_name            TEXT PRIMARY KEY,
  input_cost_per_million  REAL NOT NULL,
  output_cost_per_million REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_name, recorded_at);
```

Also add default pricing inserts after SCHEMA execution in initDb():

```ts
const DEFAULT_PRICING = [
  ['claude-opus-4-6', 15.0, 75.0],
  ['claude-sonnet-4-6', 3.0, 15.0],
  ['claude-haiku-4-5-20251001', 0.80, 4.0],
  ['gpt-4.1', 2.0, 8.0],
  ['o3', 2.0, 8.0],
  ['o4-mini', 1.10, 4.40],
];

const insertPricing = db.prepare(
  'INSERT OR IGNORE INTO pricing (model_name, input_cost_per_million, output_cost_per_million) VALUES (?, ?, ?)'
);
for (const [model, inp, out] of DEFAULT_PRICING) {
  insertPricing.run(model, inp, out);
}
```

Also update clearState() to include token_usage and pricing tables.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/state.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/state/db.ts test/state.test.ts
git commit -m \"feat: add token_usage and pricing tables with defaults\"
```

---

### Task 3: Add Token Usage CRUD Functions

**Files:**
- Modify: `src/state/index.ts`
- Test: `test/state.test.ts`

- [ ] **Step 1: Write failing tests**

Add to test/state.test.ts:

```ts
import { recordTokenUsage, getTokenUsageForAgent, getTotalCost, getPricing, upsertPricing } from '../src/state/index.ts';

describe('token usage CRUD', () => {
  test('recordTokenUsage inserts a row', () => {
    recordTokenUsage({
      agent_name: 'wk-01',
      session_id: 'sess-123',
      model: 'claude-opus-4-6',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
      source: 'statusline',
    });
    const rows = getTokenUsageForAgent('wk-01');
    expect(rows.length).toBe(1);
    expect(rows[0].cost_usd).toBe(0.05);
  });

  test('getTokenUsageForAgent returns only that agent', () => {
    recordTokenUsage({ agent_name: 'wk-01', session_id: 's1', model: 'o3', input_tokens: 100, output_tokens: 50, cost_usd: 0.01, source: 'codex_db' });
    recordTokenUsage({ agent_name: 'wk-02', session_id: 's2', model: 'o3', input_tokens: 200, output_tokens: 100, cost_usd: 0.02, source: 'codex_db' });
    const rows = getTokenUsageForAgent('wk-01');
    expect(rows.every(r => r.agent_name === 'wk-01')).toBe(true);
  });

  test('getTotalCost sums all agents', () => {
    recordTokenUsage({ agent_name: 'a1', session_id: 's1', model: 'm', input_tokens: 0, output_tokens: 0, cost_usd: 1.00, source: 'statusline' });
    recordTokenUsage({ agent_name: 'a2', session_id: 's2', model: 'm', input_tokens: 0, output_tokens: 0, cost_usd: 2.50, source: 'statusline' });
    expect(getTotalCost()).toBeCloseTo(3.50);
  });

  test('getPricing returns default entries', () => {
    const pricing = getPricing();
    expect(pricing.length).toBeGreaterThan(0);
  });

  test('upsertPricing updates existing model', () => {
    upsertPricing('claude-opus-4-6', 20.0, 100.0);
    const p = getPricing().find(e => e.model_name === 'claude-opus-4-6');
    expect(p?.input_cost_per_million).toBe(20.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/state.test.ts`
Expected: FAIL — functions not found

- [ ] **Step 3: Implement CRUD functions in state/index.ts**

Add to src/state/index.ts:

```ts
import type { TokenUsage, PricingEntry } from '../shared/types.ts';

export function recordTokenUsage(entry: Omit<TokenUsage, 'id' | 'recorded_at'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO token_usage (agent_name, session_id, model, input_tokens, output_tokens, cost_usd, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.agent_name, entry.session_id, entry.model, entry.input_tokens, entry.output_tokens, entry.cost_usd, entry.source);
}

export function getTokenUsageForAgent(agentName: string): TokenUsage[] {
  const db = getDb();
  return db.prepare('SELECT * FROM token_usage WHERE agent_name = ? ORDER BY recorded_at DESC').all(agentName) as TokenUsage[];
}

export function getLatestTokenUsage(agentName: string): TokenUsage | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM token_usage WHERE agent_name = ? ORDER BY recorded_at DESC LIMIT 1').get(agentName) as TokenUsage) ?? null;
}

export function getTotalCost(): number {
  const db = getDb();
  const row = db.prepare('SELECT SUM(cost_usd) as total FROM token_usage').get() as any;
  return row?.total ?? 0;
}

export function getAgentCost(agentName: string): number {
  const db = getDb();
  const row = db.prepare('SELECT SUM(cost_usd) as total FROM token_usage WHERE agent_name = ?').get(agentName) as any;
  return row?.total ?? 0;
}

export function getPricing(): PricingEntry[] {
  const db = getDb();
  return db.prepare('SELECT * FROM pricing ORDER BY model_name').all() as PricingEntry[];
}

export function upsertPricing(modelName: string, inputCostPerMillion: number, outputCostPerMillion: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO pricing (model_name, input_cost_per_million, output_cost_per_million)
    VALUES (?, ?, ?)
    ON CONFLICT(model_name) DO UPDATE SET
      input_cost_per_million = excluded.input_cost_per_million,
      output_cost_per_million = excluded.output_cost_per_million
  `).run(modelName, inputCostPerMillion, outputCostPerMillion);
}

export function getPricingForModel(modelName: string): PricingEntry | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM pricing WHERE model_name = ?').get(modelName) as PricingEntry) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/state.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/state/index.ts test/state.test.ts
git commit -m \"feat: add token usage and pricing CRUD functions\"
```

---

## Chunk 2: PID Mapping & Claude Code Collection

### Task 4: Implement PID Mapper

**Files:**
- Create: `src/tokens/pid-mapper.ts`
- Test: `test/tokens.test.ts`

- [ ] **Step 1: Write failing tests**

Create test/tokens.test.ts:

```ts
import { describe, test, expect } from 'bun:test';
import { getClaudePidFromPane, getSessionForPid, resolveSessionPath } from '../src/tokens/pid-mapper.ts';

describe('pid-mapper', () => {
  test('getClaudePidFromPane returns a number for a live claude pane', async () => {
    // Use our own pane — we know it's running claude
    const ownPane = process.env.TMUX_PANE;
    if (!ownPane) return; // skip if not in tmux
    const pid = await getClaudePidFromPane(ownPane);
    // Should be a positive number or null (if not a claude pane)
    if (pid !== null) {
      expect(pid).toBeGreaterThan(0);
    }
  });

  test('getClaudePidFromPane returns null for nonexistent pane', async () => {
    const pid = await getClaudePidFromPane('%99999');
    expect(pid).toBeNull();
  });

  test('getSessionForPid returns session info for valid PID', () => {
    // This test uses the filesystem — look for any existing session file
    const fs = require('fs');
    const sessDir = `${process.env.HOME}/.claude/sessions`;
    if (!fs.existsSync(sessDir)) return;
    const files = fs.readdirSync(sessDir).filter((f: string) => f.endsWith('.json'));
    if (files.length === 0) return;
    const pid = parseInt(files[0].replace('.json', ''));
    const session = getSessionForPid(pid);
    if (session) {
      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe('string');
    }
  });

  test('getSessionForPid returns null for bogus PID', () => {
    const session = getSessionForPid(999999999);
    expect(session).toBeNull();
  });

  test('resolveSessionPath builds correct JSONL path', () => {
    const path = resolveSessionPath('abc-123', '/Users/lee/code/utils/agent-crew');
    expect(path).toContain('.claude/projects/');
    expect(path).toContain('abc-123');
    expect(path).toEndWith('.jsonl');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tokens.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pid-mapper.ts**

Create src/tokens/pid-mapper.ts:

```ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME ?? '';
const CLAUDE_SESSIONS_DIR = join(HOME, '.claude', 'sessions');

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  name?: string;
}

/** tmux pane → shell PID → claude child PID */
export async function getClaudePidFromPane(paneTarget: string): Promise<number | null> {
  try {
    // Step 1: Get shell PID from tmux pane
    const shellProc = Bun.spawn(['tmux', 'display-message', '-p', '-t', paneTarget, '#{pane_pid}'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const shellPidStr = (await new Response(shellProc.stdout).text()).trim();
    await shellProc.exited;
    const shellPid = parseInt(shellPidStr);
    if (isNaN(shellPid)) return null;

    // Step 2: Find claude child process
    const pgrepProc = Bun.spawn(['pgrep', '-P', String(shellPid)], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const childPidsStr = (await new Response(pgrepProc.stdout).text()).trim();
    await pgrepProc.exited;
    if (!childPidsStr) return null;

    // There may be multiple children; find the one with a session file
    const childPids = childPidsStr.split('\
').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    for (const pid of childPids) {
      const sessionFile = join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
      if (existsSync(sessionFile)) return pid;
    }

    // If no session file match, return first child
    return childPids[0] ?? null;
  } catch {
    return null;
  }
}

/** Read session metadata from ~/.claude/sessions/<pid>.json */
export function getSessionForPid(pid: number): ClaudeSession | null {
  try {
    const sessionFile = join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
    if (!existsSync(sessionFile)) return null;
    return JSON.parse(readFileSync(sessionFile, 'utf-8'));
  } catch {
    return null;
  }
}

/** Build the path to the JSONL conversation file */
export function resolveSessionPath(sessionId: string, cwd: string): string {
  // Project hash = cwd with slashes replaced by dashes
  const projectHash = cwd.replace(/\\//g, '-');
  return join(HOME, '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
}

/** Full chain: pane → session JSONL path */
export async function resolveAgentSession(paneTarget: string): Promise<{
  claudePid: number;
  sessionId: string;
  sessionPath: string;
  model?: string;
  name?: string;
} | null> {
  const claudePid = await getClaudePidFromPane(paneTarget);
  if (!claudePid) return null;

  const session = getSessionForPid(claudePid);
  if (!session) return null;

  const sessionPath = resolveSessionPath(session.sessionId, session.cwd);
  return {
    claudePid,
    sessionId: session.sessionId,
    sessionPath,
    name: session.name,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tokens/pid-mapper.ts test/tokens.test.ts
git commit -m \"feat: add PID mapper for tmux pane to Claude Code session resolution\"
```

---

### Task 5: Implement Claude Code Token Collector

**Files:**
- Create: `src/tokens/claude-code.ts`
- Test: `test/tokens.test.ts`

- [ ] **Step 1: Write failing tests**

Add to test/tokens.test.ts:

```ts
import { parseJsonlUsage, sumUsageEntries } from '../src/tokens/claude-code.ts';

describe('claude-code token collection', () => {
  test('parseJsonlUsage extracts usage from JSONL lines', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 }, stop_reason: 'end_turn' } }),
      JSON.stringify({ type: 'human', text: 'hello' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-6', usage: { input_tokens: 150, output_tokens: 75 }, stop_reason: 'end_turn' } }),
    ];
    const entries = parseJsonlUsage(lines.join('\
'));
    expect(entries.length).toBe(2);
    expect(entries[0].input_tokens).toBe(100);
    expect(entries[0].output_tokens).toBe(50);
    expect(entries[0].model).toBe('claude-opus-4-6');
  });

  test('sumUsageEntries totals tokens correctly', () => {
    const entries = [
      { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 0, model: 'claude-opus-4-6' },
      { input_tokens: 150, output_tokens: 75, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, model: 'claude-opus-4-6' },
    ];
    const totals = sumUsageEntries(entries);
    expect(totals.input_tokens).toBe(250);
    expect(totals.output_tokens).toBe(125);
    expect(totals.model).toBe('claude-opus-4-6');
  });

  test('parseJsonlUsage handles empty input', () => {
    expect(parseJsonlUsage('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tokens.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement claude-code.ts**

Create src/tokens/claude-code.ts:

```ts
import { readFileSync, existsSync } from 'fs';
import { resolveAgentSession } from './pid-mapper.ts';
import { recordTokenUsage, getPricingForModel, getLatestTokenUsage } from '../state/index.ts';

interface UsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model: string;
}

interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  model: string;
}

/** Parse JSONL content and extract usage entries from assistant messages */
export function parseJsonlUsage(content: string): UsageEntry[] {
  if (!content.trim()) return [];
  const entries: UsageEntry[] = [];
  for (const line of content.split('\
')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        entries.push({
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          model: obj.message.model ?? 'unknown',
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** Sum up all usage entries into totals */
export function sumUsageEntries(entries: UsageEntry[]): UsageTotals {
  let input = 0, output = 0;
  let model = 'unknown';
  for (const e of entries) {
    input += e.input_tokens;
    output += e.output_tokens;
    model = e.model; // last model used
  }
  return { input_tokens: input, output_tokens: output, model };
}

/** Collect tokens for a Claude Code agent by parsing their session JSONL */
export async function collectClaudeCodeTokens(agentName: string, paneTarget: string): Promise<void> {
  const session = await resolveAgentSession(paneTarget);
  if (!session) return;

  if (!existsSync(session.sessionPath)) return;

  const content = readFileSync(session.sessionPath, 'utf-8');
  const entries = parseJsonlUsage(content);
  if (entries.length === 0) return;

  const totals = sumUsageEntries(entries);

  // Check if we already have a record for this session with the same token count
  const latest = getLatestTokenUsage(agentName);
  if (latest?.session_id === session.sessionId &&
      latest.input_tokens === totals.input_tokens &&
      latest.output_tokens === totals.output_tokens) {
    return; // no change
  }

  // Calculate cost from pricing table
  const pricing = getPricingForModel(totals.model);
  const cost = pricing
    ? (totals.input_tokens / 1_000_000) * pricing.input_cost_per_million +
      (totals.output_tokens / 1_000_000) * pricing.output_cost_per_million
    : null;

  recordTokenUsage({
    agent_name: agentName,
    session_id: session.sessionId,
    model: totals.model,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cost_usd: cost,
    source: 'jsonl',
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tokens/claude-code.ts test/tokens.test.ts
git commit -m \"feat: add Claude Code token collection via JSONL parsing\"
```

---

### Task 6: Implement Codex Token Collector

**Files:**
- Create: `src/tokens/codex.ts`
- Test: `test/tokens.test.ts`

- [ ] **Step 1: Write failing tests**

Add to test/tokens.test.ts:

```ts
import { readCodexThreads } from '../src/tokens/codex.ts';

describe('codex token collection', () => {
  test('readCodexThreads returns array (may be empty if no codex db)', () => {
    const threads = readCodexThreads();
    expect(Array.isArray(threads)).toBe(true);
  });

  test('readCodexThreads entries have expected shape', () => {
    const threads = readCodexThreads();
    if (threads.length === 0) return; // skip if no codex installed
    const first = threads[0];
    expect(first).toHaveProperty('tokens_used');
    expect(first).toHaveProperty('model');
    expect(typeof first.tokens_used).toBe('number');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tokens.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement codex.ts**

Create src/tokens/codex.ts:

```ts
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { join } from 'path';
import { recordTokenUsage, getPricingForModel, getLatestTokenUsage } from '../state/index.ts';

const HOME = process.env.HOME ?? '';
const CODEX_DB_PATH = join(HOME, '.codex', 'state_5.sqlite');

interface CodexThread {
  id: string;
  model: string;
  tokens_used: number;
  created_at: string;
  updated_at: string;
  title: string | null;
}

/** Read all threads from Codex's local SQLite DB */
export function readCodexThreads(): CodexThread[] {
  if (!existsSync(CODEX_DB_PATH)) return [];
  try {
    const db = new Database(CODEX_DB_PATH, { readonly: true });
    const rows = db.prepare('SELECT id, model, tokens_used, created_at, updated_at, title FROM threads ORDER BY updated_at DESC').all() as CodexThread[];
    db.close();
    return rows;
  } catch {
    return [];
  }
}

/** Get the most recent active thread (likely the current session) */
export function getLatestCodexThread(): CodexThread | null {
  const threads = readCodexThreads();
  return threads[0] ?? null;
}

/** Collect tokens for a Codex agent. Match by most recent thread activity. */
export function collectCodexTokens(agentName: string): void {
  const thread = getLatestCodexThread();
  if (!thread || thread.tokens_used === 0) return;

  // Check if we already recorded this exact state
  const latest = getLatestTokenUsage(agentName);
  if (latest?.session_id === thread.id &&
      latest.input_tokens === thread.tokens_used) {
    return; // no change
  }

  // Codex only stores total tokens_used, not input/output breakdown
  // Use pricing to estimate cost; tokens_used is roughly total (in+out)
  const pricing = getPricingForModel(thread.model);
  // Rough split: assume 70% input, 30% output for cost estimation
  const estInput = Math.round(thread.tokens_used * 0.7);
  const estOutput = Math.round(thread.tokens_used * 0.3);
  const cost = pricing
    ? (estInput / 1_000_000) * pricing.input_cost_per_million +
      (estOutput / 1_000_000) * pricing.output_cost_per_million
    : null;

  recordTokenUsage({
    agent_name: agentName,
    session_id: thread.id,
    model: thread.model,
    input_tokens: thread.tokens_used, // total tokens (best we have)
    output_tokens: 0, // not broken out by codex
    cost_usd: cost,
    source: 'codex_db',
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tokens/codex.ts test/tokens.test.ts
git commit -m \"feat: add Codex CLI token collection via local SQLite\"
```

---

## Chunk 3: Collection Loop & Server Integration

### Task 7: Implement Token Collection Loop

**Files:**
- Create: `src/tokens/collector.ts`
- Test: `test/tokens.test.ts`

- [ ] **Step 1: Write failing tests**

Add to test/tokens.test.ts:

```ts
import { identifyAgentType } from '../src/tokens/collector.ts';

describe('token collector', () => {
  test('identifyAgentType detects claude code from pane output', () => {
    const claudeOutput = '❯ \
\
· Thinking… (3s)';
    expect(identifyAgentType(claudeOutput)).toBe('claude-code');
  });

  test('identifyAgentType detects codex from pane output', () => {
    const codexOutput = 'codex> thinking about your request...';
    expect(identifyAgentType(codexOutput)).toBe('codex');
  });

  test('identifyAgentType returns unknown for unrecognized output', () => {
    expect(identifyAgentType('some random text')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tokens.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement collector.ts**

Create src/tokens/collector.ts:

```ts
import { getAllAgents } from '../state/index.ts';
import { capturePane } from '../tmux/index.ts';
import { collectClaudeCodeTokens } from './claude-code.ts';
import { collectCodexTokens } from './codex.ts';

const COLLECT_INTERVAL_MS = 30_000; // 30 seconds

/** Detect agent type from pane output patterns */
export function identifyAgentType(paneOutput: string): 'claude-code' | 'codex' | 'unknown' {
  // Claude Code patterns: status spinner, prompt, or completion marker
  if (/^[❯·*✶✽✻]/m.test(paneOutput)) return 'claude-code';
  // Codex patterns
  if (/codex>/i.test(paneOutput)) return 'codex';
  return 'unknown';
}

/** Run one collection cycle for all registered agents */
export async function collectAllTokens(): Promise<void> {
  const agents = getAllAgents();
  const promises = agents.map(async (agent) => {
    try {
      const output = await capturePane(agent.pane);
      if (!output) return;

      const agentType = identifyAgentType(output);
      if (agentType === 'claude-code') {
        await collectClaudeCodeTokens(agent.name, agent.pane);
      } else if (agentType === 'codex') {
        collectCodexTokens(agent.name);
      }
    } catch (err) {
      // Silently skip — agent may be dead
    }
  });
  await Promise.all(promises);
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Start the token collection loop (30s interval) */
export function startTokenCollection(): void {
  if (intervalHandle) return; // already running
  // Run immediately, then every 30s
  collectAllTokens();
  intervalHandle = setInterval(collectAllTokens, COLLECT_INTERVAL_MS);
}

/** Stop the token collection loop */
export function stopTokenCollection(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tokens/collector.ts test/tokens.test.ts
git commit -m \"feat: add token collection loop with agent type detection\"
```

---

### Task 8: Integrate Collection Loop into Server

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import and start call**

In src/index.ts, add import at top:

```ts
import { startTokenCollection } from './tokens/collector.ts';
```

Add call after the MCP server is initialized (after `server.connect(transport)` or equivalent startup):

```ts
// Start passive token collection (30s interval)
startTokenCollection();
```

- [ ] **Step 2: Run full test suite to verify no regressions**

Run: `bun test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m \"feat: start token collection loop on MCP server init\"
```

---

## Chunk 4: Dashboard Integration

### Task 9: Add Token Data to Dashboard State

**Files:**
- Modify: `src/dashboard/hooks/useStateReader.ts`
- Modify: `src/shared/types.ts` (if TokenUsage not already imported)

- [ ] **Step 1: Update DashboardState interface**

In src/dashboard/hooks/useStateReader.ts, add to DashboardState:

```ts
tokenUsage: TokenUsage[];
```

Update EMPTY_STATE:

```ts
tokenUsage: [],
```

- [ ] **Step 2: Add token_usage query to readAll()**

In readAll(), add after the tasks query (with same try/catch pattern for missing table):

```ts
let tokenUsage: TokenUsage[] = [];
try {
  tokenUsage = db.prepare('SELECT * FROM token_usage ORDER BY recorded_at DESC').all() as TokenUsage[];
} catch {
  tokenUsage = [];
}
```

Include tokenUsage in the return object.

- [ ] **Step 3: Update quickHash to include token data**

Add to the hash computation:

```ts
const latestTokenCost = tokenUsage[0]?.cost_usd ?? 0;
```

Include `latestTokenCost` in the hash string.

- [ ] **Step 4: Run dashboard tests**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS (may need to update test mocks for new field)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/hooks/useStateReader.ts
git commit -m \"feat: add token usage data to dashboard state reader\"
```

---

### Task 10: Pass Token Data Through App.tsx

**Files:**
- Modify: `src/dashboard/App.tsx`

- [ ] **Step 1: Pass tokenUsage to components**

Add `tokenUsage={state.tokenUsage}` prop to:
- HeaderStats
- DetailsPanel
- TreePanel

- [ ] **Step 2: Verify it compiles**

Run: `bun build src/dashboard/App.tsx --no-bundle`
Expected: No errors (component props will be updated in subsequent tasks)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/App.tsx
git commit -m \"feat: pass token usage data to dashboard components\"
```

---

### Task 11: Show Total Crew Cost in HeaderStats

**Files:**
- Modify: `src/dashboard/components/HeaderStats.tsx`

- [ ] **Step 1: Add tokenUsage to props**

```ts
interface HeaderStatsProps {
  // ... existing props
  tokenUsage: TokenUsage[];
}
```

- [ ] **Step 2: Compute and display total cost**

Add cost computation:

```ts
const totalCost = tokenUsage.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
```

But we need to be smarter — token_usage has multiple snapshots per agent. We want the LATEST snapshot per agent, not a sum of all snapshots. Use a Map to deduplicate:

```ts
const latestByAgent = new Map<string, TokenUsage>();
for (const t of tokenUsage) {
  if (!latestByAgent.has(t.agent_name)) {
    latestByAgent.set(t.agent_name, t); // already sorted DESC by recorded_at
  }
}
const totalCost = [...latestByAgent.values()].reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
const totalTokens = [...latestByAgent.values()].reduce((sum, t) => sum + t.input_tokens + t.output_tokens, 0);
```

Display after the existing task stats:

```tsx
<Text> Cost: </Text>
<Text color=\"green\">${totalCost.toFixed(2)}</Text>
<Text dimColor> ({formatTokenCount(totalTokens)} tok)</Text>
```

Add helper:

```ts
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 3: Run dashboard tests**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS (update test mocks if needed)

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/HeaderStats.tsx
git commit -m \"feat: show total crew cost and tokens in dashboard header\"
```

---

### Task 12: Show Per-Agent Cost in DetailsPanel

**Files:**
- Modify: `src/dashboard/components/DetailsPanel.tsx`

- [ ] **Step 1: Add tokenUsage to props**

```ts
interface DetailsPanelProps {
  // ... existing props
  tokenUsage: TokenUsage[];
}
```

- [ ] **Step 2: Add cost display to AgentDetails view**

In the agent detail section, after the existing stats, add:

```tsx
// Find latest token usage for this agent
const agentTokens = tokenUsage.find(t => t.agent_name === agent.name);
```

Display:

```tsx
{agentTokens && (
  <>
    <Text bold>  Cost:</Text>
    <Text>    Session: </Text>
    <Text color=\"green\">${(agentTokens.cost_usd ?? 0).toFixed(4)}</Text>
    <Text>    Model: </Text>
    <Text dimColor>{agentTokens.model ?? 'unknown'}</Text>
    <Text>    Tokens: </Text>
    <Text>{formatTokenCount(agentTokens.input_tokens)} in / {formatTokenCount(agentTokens.output_tokens)} out</Text>
    <Text>    Source: </Text>
    <Text dimColor>{agentTokens.source}</Text>
  </>
)}
```

- [ ] **Step 3: Run dashboard tests**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/DetailsPanel.tsx
git commit -m \"feat: show per-agent token cost in dashboard details panel\"
```

---

### Task 13: Show Inline Cost in TreePanel

**Files:**
- Modify: `src/dashboard/components/TreePanel.tsx`

- [ ] **Step 1: Add tokenUsage to props**

```ts
interface TreePanelProps {
  // ... existing props
  tokenUsage: TokenUsage[];
}
```

- [ ] **Step 2: Add inline cost after agent name**

Build a cost lookup map:

```ts
const costByAgent = useMemo(() => {
  const map = new Map<string, number>();
  for (const t of tokenUsage) {
    if (!map.has(t.agent_name)) {
      map.set(t.agent_name, t.cost_usd ?? 0);
    }
  }
  return map;
}, [tokenUsage]);
```

In the agent row rendering, after the existing task indicators, add:

```tsx
{costByAgent.has(agentName) && (
  <Text dimColor> ${costByAgent.get(agentName)!.toFixed(2)}</Text>
)}
```

- [ ] **Step 3: Run dashboard tests**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/TreePanel.tsx
git commit -m \"feat: show inline cost per agent in dashboard tree panel\"
```

---

## Chunk 5: Documentation & Verification

### Task 14: Update Architecture Docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Add Token Tracking section to architecture.md**

Add a new section \"## Token Usage Tracking\" covering:
- Data sources: Claude Code JSONL parsing, Codex SQLite DB
- PID mapping chain: tmux pane → shell PID → claude PID → session file → JSONL
- Collection loop: 30s interval, agent type detection from pane output
- Storage: token_usage table (snapshots), pricing table (configurable)
- Dashboard integration: HeaderStats total, DetailsPanel per-agent, TreePanel inline

- [ ] **Step 2: Update README.md**

Add token tracking to the features list. Note the supported agent types.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md README.md
git commit -m \"docs: add token usage tracking architecture and README updates\"
```

---

### Task 15: Full Test Suite & UAT

- [ ] **Step 1: Run full unit tests**

Run: `bun test`
Expected: All pass. Report exact count.

- [ ] **Step 2: Run UAT**

Run: `bun test/uat-send-reliability.ts`
Expected: All pass.

- [ ] **Step 3: Manual verification**

Run the dashboard: `bun run --cwd ~/.crew dashboard`
Verify:
- HeaderStats shows cost (may be $0.00 if no collection has run yet)
- No crashes or hangs
- Agent detail view has cost section (empty if no data)

- [ ] **Step 4: Report results**

Report: test counts, any failures, dashboard behavior.

