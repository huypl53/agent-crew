#!/usr/bin/env bun
/**
 * Polls a tmux pane and shows hash changes for both text-only and ANSI modes.
 *
 * Usage: bun crew/scripts/validate-ansi-poll.ts <pane-id> [interval-ms]
 * Example: bun crew/scripts/validate-ansi-poll.ts %5 1000
 *
 * Watch this while changing Claude Code's state to see which hashes change.
 */

const target = process.argv[2];
const interval = parseInt(process.argv[3] || '1000', 10);

if (!target) {
  console.error('Usage: bun crew/scripts/validate-ansi-poll.ts <pane-id> [interval-ms]');
  process.exit(1);
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash >>> 0;
}

async function capturePane(withAnsi: boolean, lines?: number): Promise<string | null> {
  try {
    const args = ['tmux', 'capture-pane', '-t', target, '-p'];
    if (withAnsi) args.push('-e');
    if (lines) args.push('-S', String(-lines));
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return stdout;
  } catch {
    return null;
  }
}

interface State {
  fullText: number;
  fullAnsi: number;
  last5Text: number;
  last5Ansi: number;
  last3Text: number;
  last3Ansi: number;
}

let prevState: State | null = null;
let tick = 0;

function diff(label: string, prev: number, curr: number): string {
  if (prev === curr) return `${label}: ${curr}`;
  return `${label}: ${prev} → ${curr} CHANGED`;
}

async function poll() {
  tick++;
  const fullText = await capturePane(false);
  const fullAnsi = await capturePane(true);
  const last5Text = await capturePane(false, 5);
  const last5Ansi = await capturePane(true, 5);
  const last3Text = await capturePane(false, 3);
  const last3Ansi = await capturePane(true, 3);

  if (!fullText) {
    console.log(`[${tick}] Failed to capture pane`);
    return;
  }

  const state: State = {
    fullText: simpleHash(fullText!),
    fullAnsi: simpleHash(fullAnsi!),
    last5Text: simpleHash(last5Text!),
    last5Ansi: simpleHash(last5Ansi!),
    last3Text: simpleHash(last3Text!),
    last3Ansi: simpleHash(last3Ansi!),
  };

  if (!prevState) {
    console.log(`[${tick}] Initial state captured`);
    console.log(`  Full:   text=${state.fullText} ansi=${state.fullAnsi}`);
    console.log(`  Last5:  text=${state.last5Text} ansi=${state.last5Ansi}`);
    console.log(`  Last3:  text=${state.last3Text} ansi=${state.last3Ansi}`);
    prevState = state;
    return;
  }

  const changes: string[] = [];
  if (state.fullText !== prevState.fullText) changes.push('fullText');
  if (state.fullAnsi !== prevState.fullAnsi) changes.push('fullAnsi');
  if (state.last5Text !== prevState.last5Text) changes.push('last5Text');
  if (state.last5Ansi !== prevState.last5Ansi) changes.push('last5Ansi');
  if (state.last3Text !== prevState.last3Text) changes.push('last3Text');
  if (state.last3Ansi !== prevState.last3Ansi) changes.push('last3Ansi');

  if (changes.length === 0) {
    process.stdout.write('.');
  } else {
    const textOnlyChanged = changes.some((c) => c.includes('Text') && !c.includes('Ansi'));
    const ansiOnlyChanged = changes.some((c) => c.includes('Ansi')) && !textOnlyChanged;

    console.log(`\n[${tick}] CHANGES: ${changes.join(', ')}`);
    if (ansiOnlyChanged) {
      console.log('  ^^^ ANSI-only change detected (color/style changed, text same)');
    }
    console.log(`  Full:  text=${state.fullText} ansi=${state.fullAnsi}`);
    console.log(`  Last5: text=${state.last5Text} ansi=${state.last5Ansi}`);
    console.log(`  Last3: text=${state.last3Text} ansi=${state.last3Ansi}`);
  }

  prevState = state;
}

console.log(`Polling pane ${target} every ${interval}ms. Press Ctrl+C to stop.\n`);
console.log('Legend: . = no change, CHANGES = what changed\n');

setInterval(poll, interval);
poll();
