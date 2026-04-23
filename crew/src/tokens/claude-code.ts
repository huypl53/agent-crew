import { existsSync, readFileSync } from 'fs';
import {
  getLatestTokenUsage,
  getPricingForModel,
  recordTokenUsage,
} from '../state/index.ts';
import { resolveAgentSession } from './pid-mapper.ts';

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

export function parseJsonlUsage(content: string): UsageEntry[] {
  if (!content.trim()) return [];
  const entries: UsageEntry[] = [];
  for (const line of content.split('\n')) {
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
      /* skip malformed lines */
    }
  }
  return entries;
}

export function sumUsageEntries(entries: UsageEntry[]): UsageTotals {
  let input = 0,
    output = 0;
  let model = 'unknown';
  for (const e of entries) {
    input += e.input_tokens;
    output += e.output_tokens;
    model = e.model;
  }
  return { input_tokens: input, output_tokens: output, model };
}

export async function collectClaudeCodeTokens(
  agentName: string,
  paneTarget: string,
): Promise<void> {
  const session = await resolveAgentSession(paneTarget);
  if (!session) return;
  if (!existsSync(session.sessionPath)) return;

  const content = readFileSync(session.sessionPath, 'utf-8');
  const entries = parseJsonlUsage(content);
  if (entries.length === 0) return;

  const totals = sumUsageEntries(entries);

  const latest = getLatestTokenUsage(agentName);
  if (
    latest?.session_id === session.sessionId &&
    latest.input_tokens === totals.input_tokens &&
    latest.output_tokens === totals.output_tokens
  ) {
    return; // no change — dedup
  }

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
