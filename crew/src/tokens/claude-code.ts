import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'fs';
import {
  getAgent,
  getLatestTokenUsage,
  getPricingForModel,
  recordTokenUsage,
} from '../state/index.ts';
import { getContextLimit } from './context-limits.ts';
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

/** Latest context window snapshot from a session JSONL. */
export interface ContextWindowInfo {
  model: string;
  context_used: number; // input + cache_create + cache_read + output
  context_limit: number;
  context_pct: number; // 0–100
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

  const agent = getAgent(agentName);
  if (!agent) return;

  recordTokenUsage({
    agent_id: agent.agent_id,
    session_id: session.sessionId,
    model: totals.model,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cost_usd: cost,
    source: 'jsonl',
  });
}

// --- On-demand context window reading ---

/** Read last N lines of a file efficiently using seek. */
function tailFileLines(filePath: string, maxLines = 50): string {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size === 0) return '';

    // Read last 16KB (enough for ~50 JSONL lines)
    const readSize = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(readSize);
    const offset = size - readSize;
    readSync(fd, buf, 0, readSize, offset);

    const text = buf.toString('utf-8');
    // If we didn't start at 0, discard first partial line
    const lines = text.split('\n');
    if (offset > 0 && lines.length > 1) lines.shift();
    return lines.join('\n');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the latest context window info from an agent's session JSONL.
 * Efficient: only reads the last ~16KB of the file.
 */
export async function getContextWindowForPane(
  paneTarget: string,
): Promise<ContextWindowInfo | null> {
  const session = await resolveAgentSession(paneTarget);
  if (!session) return null;
  if (!existsSync(session.sessionPath)) return null;

  const tail = tailFileLines(session.sessionPath);
  if (!tail.trim()) return null;

  // Walk lines in reverse to find the last assistant entry with usage
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        const input = u.input_tokens ?? 0;
        const cacheCreate = u.cache_creation_input_tokens ?? 0;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const output = u.output_tokens ?? 0;
        const model = obj.message.model ?? 'unknown';
        const contextUsed = input + cacheCreate + cacheRead + output;
        const limit = getContextLimit(model);
        return {
          model,
          context_used: contextUsed,
          context_limit: limit,
          context_pct: Math.round((contextUsed / limit) * 1000) / 10, // 1 decimal
        };
      }
    } catch {}
  }

  return null;
}
