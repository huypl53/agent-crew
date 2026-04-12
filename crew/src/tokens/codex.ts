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

export function getLatestCodexThread(): CodexThread | null {
  const threads = readCodexThreads();
  return threads[0] ?? null;
}

/** Collect tokens for a Codex agent. 70/30 input/output estimate for cost. */
export function collectCodexTokens(agentName: string): void {
  const thread = getLatestCodexThread();
  if (!thread || thread.tokens_used === 0) return;

  const latest = getLatestTokenUsage(agentName);
  if (latest?.session_id === thread.id && latest.input_tokens === thread.tokens_used) {
    return; // no change — dedup
  }

  const pricing = getPricingForModel(thread.model);
  // Codex only stores total tokens_used — estimate 70% input, 30% output for cost
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
    input_tokens: estInput,
    output_tokens: estOutput,
    cost_usd: cost,
    source: 'codex_db',
  });
}
