#!/usr/bin/env bun
/**
 * Validates ANSI color detection for idle status checking.
 *
 * Usage: bun crew/scripts/validate-ansi-detection.ts <pane-id>
 * Example: bun crew/scripts/validate-ansi-detection.ts %5
 *
 * Run this on a Claude Code pane in different states (idle, thinking, working)
 * to see if ANSI codes differ.
 */

import { $ } from 'bun';

const target = process.argv[2];
if (!target) {
  console.error('Usage: bun crew/scripts/validate-ansi-detection.ts <pane-id>');
  console.error('Example: bun crew/scripts/validate-ansi-detection.ts %5');
  process.exit(1);
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash >>> 0; // unsigned
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function hexDump(str: string, maxLen = 200): string {
  const truncated = str.slice(0, maxLen);
  return truncated
    .split('')
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code === 27) return '\\e';
      if (code === 10) return '\\n';
      if (code === 13) return '\\r';
      if (code < 32) return `\\x${code.toString(16).padStart(2, '0')}`;
      return c;
    })
    .join('');
}

async function capturePane(withAnsi: boolean, lines?: number): Promise<string | null> {
  try {
    const args = ['tmux', 'capture-pane', '-t', target, '-p'];
    if (withAnsi) args.push('-e');
    if (lines) {
      args.push('-S', String(-lines));
    }
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return stdout;
  } catch {
    return null;
  }
}

async function run() {
  console.log(`\n=== ANSI Detection Validation for pane ${target} ===\n`);

  // Full pane capture
  const fullText = await capturePane(false);
  const fullAnsi = await capturePane(true);

  if (!fullText || !fullAnsi) {
    console.error(`Failed to capture pane ${target}. Is it a valid tmux pane?`);
    process.exit(1);
  }

  const fullTextHash = simpleHash(fullText);
  const fullAnsiHash = simpleHash(fullAnsi);

  console.log('--- FULL PANE ---');
  console.log(`Text-only hash: ${fullTextHash}`);
  console.log(`ANSI hash:      ${fullAnsiHash}`);
  console.log(`Hashes differ:  ${fullTextHash !== fullAnsiHash ? 'YES ✓' : 'NO (same)'}`);
  console.log(`Text length:    ${fullText.length}`);
  console.log(`ANSI length:    ${fullAnsi.length} (+${fullAnsi.length - fullText.length} bytes from ANSI)`);

  // Last 5 lines (status region)
  const statusText = await capturePane(false, 5);
  const statusAnsi = await capturePane(true, 5);

  if (statusText && statusAnsi) {
    const statusTextHash = simpleHash(statusText);
    const statusAnsiHash = simpleHash(statusAnsi);

    console.log('\n--- LAST 5 LINES (Status Region) ---');
    console.log(`Text-only hash: ${statusTextHash}`);
    console.log(`ANSI hash:      ${statusAnsiHash}`);
    console.log(`Hashes differ:  ${statusTextHash !== statusAnsiHash ? 'YES ✓' : 'NO (same)'}`);

    console.log('\n--- Status Region Content (text-only) ---');
    console.log(statusText.trim());

    console.log('\n--- Status Region Raw (with ANSI escaped) ---');
    console.log(hexDump(statusAnsi, 500));
  }

  // Last 3 lines
  const last3Text = await capturePane(false, 3);
  const last3Ansi = await capturePane(true, 3);

  if (last3Text && last3Ansi) {
    const last3TextHash = simpleHash(last3Text);
    const last3AnsiHash = simpleHash(last3Ansi);

    console.log('\n--- LAST 3 LINES ---');
    console.log(`Text-only hash: ${last3TextHash}`);
    console.log(`ANSI hash:      ${last3AnsiHash}`);
    console.log(`Hashes differ:  ${last3TextHash !== last3AnsiHash ? 'YES ✓' : 'NO (same)'}`);

    console.log('\n--- Last 3 Lines Raw (with ANSI escaped) ---');
    console.log(hexDump(last3Ansi, 300));
  }

  // Detect ANSI sequences present
  const ansiPattern = /\x1b\[([0-9;]*)([a-zA-Z])/g;
  const matches = [...fullAnsi.matchAll(ansiPattern)];
  const uniqueCodes = new Set(matches.map((m) => `\\e[${m[1]}${m[2]}`));

  console.log('\n--- ANSI Sequences Found ---');
  console.log(`Total sequences: ${matches.length}`);
  console.log(`Unique codes:    ${uniqueCodes.size}`);
  if (uniqueCodes.size > 0 && uniqueCodes.size <= 20) {
    console.log('Codes:', [...uniqueCodes].join(', '));
  }

  console.log('\n=== END ===\n');
}

run().catch(console.error);
