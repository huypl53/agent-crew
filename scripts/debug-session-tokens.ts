/**
 * Debug script: collect token usage from a Claude Code session JSONL file.
 *
 * Usage:
 *   bun scripts/debug-session-tokens.ts <jsonl-path> [session-id]
 *
 * If session-id is omitted, reads all entries in the file.
 */

import { readFileSync } from "node:fs";

// ── Model context window limits ──────────────────────────────
const MODEL_CONTEXT: Record<string, number> = {
  "claude-opus-4-8": 200_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5-20250514": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "glm-5.1": 200_000,
  "gpt-4.1": 1_047_576,
  "o3": 200_000,
  "o4-mini": 200_000,
};

// ── Types ────────────────────────────────────────────────────
interface UsageEntry {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  model: string;
}

interface TurnRow {
  turn: number;
  model: string;
  input: number;
  cache_create: number;
  cache_read: number;
  output: number;
  context_used: number; // input + cache_create + cache_read + output
}

// ── Parse ────────────────────────────────────────────────────
function parseJsonl(content: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "assistant" && obj.message?.usage) {
        const u = obj.message.usage;
        entries.push({
          input_tokens: u.input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          model: obj.message.model ?? "unknown",
        });
      }
    } catch {
      /* skip */
    }
  }
  return entries;
}

// ── Format helpers ───────────────────────────────────────────
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(used: number, max: number): string {
  const p = ((used / max) * 100).toFixed(1);
  return `${p}%`;
}

// ── Main ─────────────────────────────────────────────────────
const jsonlPath = process.argv[2];
if (!jsonlPath) {
  console.error("Usage: bun scripts/debug-session-tokens.ts <jsonl-path>");
  process.exit(1);
}

const sessionId = process.argv[3]; // optional filter

const content = readFileSync(jsonlPath, "utf-8");
const entries = parseJsonl(content);

if (entries.length === 0) {
  console.log("No assistant messages with usage data found.");
  process.exit(0);
}

// ── Per-turn table ───────────────────────────────────────────
console.log(`\n=== Token Usage: ${jsonlPath} ===`);
console.log(`Total assistant turns: ${entries.length}\n`);

const rows: TurnRow[] = entries.map((e, i) => ({
  turn: i + 1,
  model: e.model,
  input: e.input_tokens,
  cache_create: e.cache_creation_input_tokens,
  cache_read: e.cache_read_input_tokens,
  output: e.output_tokens,
  context_used:
    e.input_tokens +
    e.cache_creation_input_tokens +
    e.cache_read_input_tokens +
    e.output_tokens,
}));

// Header
const header = [
  "Turn".padStart(5),
  "Model".padEnd(20),
  "Input".padStart(8),
  "CacheCr".padStart(8),
  "CacheRd".padStart(8),
  "Output".padStart(8),
  "CtxUsed".padStart(10),
  "Ctx%".padStart(7),
].join("  ");
console.log(header);
console.log("-".repeat(header.length));

// Rows
let totalInput = 0;
let totalOutput = 0;
let totalCacheCreate = 0;
let totalCacheRead = 0;

for (const r of rows) {
  totalInput += r.input;
  totalOutput += r.output;
  totalCacheCreate += r.cache_create;
  totalCacheRead += r.cache_read;

  const maxCtx = MODEL_CONTEXT[r.model] ?? 200_000;
  const line = [
    String(r.turn).padStart(5),
    r.model.padEnd(20),
    fmt(r.input).padStart(8),
    fmt(r.cache_create).padStart(8),
    fmt(r.cache_read).padStart(8),
    fmt(r.output).padStart(8),
    fmt(r.context_used).padStart(10),
    pct(r.context_used, maxCtx).padStart(7),
  ].join("  ");
  console.log(line);
}

// ── Summary ──────────────────────────────────────────────────
const latest = rows[rows.length - 1]!;
const maxCtx = MODEL_CONTEXT[latest.model] ?? 200_000;

console.log("\n" + "=".repeat(80));
console.log(`Latest turn (#${rows.length}):`);
console.log(`  Model:          ${latest.model}`);
console.log(`  Input:          ${fmt(latest.input)}`);
console.log(`  Cache Create:   ${fmt(latest.cache_create)}`);
console.log(`  Cache Read:     ${fmt(latest.cache_read)}`);
console.log(`  Output:         ${fmt(latest.output)}`);
console.log(`  Context Used:   ${fmt(latest.context_used)} / ${fmt(maxCtx)} (${pct(latest.context_used, maxCtx)})`);
console.log(`  Context Headroom: ${fmt(maxCtx - latest.context_used)} tokens remaining`);

console.log("\nSession totals (cumulative across all turns):");
console.log(`  Total input tokens (billed):     ${fmt(totalInput)}`);
console.log(`  Total cache_create tokens:       ${fmt(totalCacheCreate)}`);
console.log(`  Total cache_read tokens:         ${fmt(totalCacheRead)}`);
console.log(`  Total output tokens:             ${fmt(totalOutput)}`);
console.log(`  Total billed input (in+cc+cr):   ${fmt(totalInput + totalCacheCreate + totalCacheRead)}`);
console.log(`  Total all tokens:                ${fmt(totalInput + totalCacheCreate + totalCacheRead + totalOutput)}`);

// Cost estimation (rough, using the pricing table defaults)
const PRICING: Record<string, [number, number]> = {
  "claude-opus-4-8": [15, 75],
  "claude-opus-4-7": [15, 75],
  "claude-opus-4-6": [15, 75],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5-20250514": [3, 15],
  "claude-haiku-4-5-20251001": [0.8, 4],
  "glm-5.1": [3, 15], // estimate
};

const prices = PRICING[latest.model];
if (prices) {
  const totalBilledInput = totalInput + totalCacheCreate + totalCacheRead;
  const cost = (totalBilledInput / 1_000_000) * prices[0] + (totalOutput / 1_000_000) * prices[1];
  console.log(`  Estimated cost:                 $${cost.toFixed(4)}`);
}

console.log();
