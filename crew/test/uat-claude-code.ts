#!/usr/bin/env bun
/**
 * UAT: Real Claude Code send reliability test.
 *
 * Sends messages of various sizes to a LIVE Claude Code instance via sendKeys()
 * and verifies Claude Code actually received and processed them (not stuck with
 * unsubmitted text in the input buffer).
 *
 * Prerequisites:
 *   - A tmux pane running Claude Code (provide pane ID as arg)
 *   - Claude Code must be at the ❯ prompt (idle)
 *
 * Usage:
 *   bun test/uat-claude-code.ts <tmux-pane-id>
 *
 * Example:
 *   bun test/uat-claude-code.ts %5
 */
import { sendKeys } from '../src/tmux/index.ts';

const paneId = process.argv[2];

if (!paneId) {
  console.error('Usage: bun test/uat-claude-code.ts <tmux-pane-id>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function capturePaneFull(): Promise<string> {
  const proc = Bun.spawn(
    ['tmux', 'capture-pane', '-p', '-J', '-t', paneId, '-S', '-500'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

function isIdle(paneText: string): boolean {
  const lines = paneText.split('\n');
  const bottom = lines.slice(-10).join('\n');
  const hasPrompt = bottom.includes('❯');
  const isBusy = /[·✶✽✻]\s+\w+…/.test(bottom);
  return hasPrompt && !isBusy;
}

// Wait until expectedMarker appears in pane AND Claude Code returns to idle
async function waitForResponse(
  expectedMarker: string,
  timeoutMs = 120_000,
): Promise<{ idle: boolean; found: boolean }> {
  const deadline = Date.now() + timeoutMs;
  // Give Claude Code a moment to start processing
  await Bun.sleep(2000);
  let foundMarker = false;
  while (Date.now() < deadline) {
    const text = await capturePaneFull();
    if (text.includes(expectedMarker)) foundMarker = true;
    if (foundMarker && isIdle(text)) {
      return { idle: true, found: true };
    }
    // Also check: is the text stuck in input buffer? (Enter didn't fire)
    // If the bottom shows ❯ with our message text still in the prompt, Enter failed
    const lines = text.split('\n');
    const promptArea = lines.slice(-10).join('\n');
    if (isIdle(text) && !foundMarker) {
      // Idle but marker not found — either Enter didn't fire or Claude gave unexpected response
      // Check if our message text is stuck in the input area
      const inputLine = lines.find(
        (l) => l.includes('❯') && l.trim().length > 2,
      );
      if (inputLine && inputLine.length > 10) {
        // Something in the input — might be stuck
        return { idle: true, found: false };
      }
    }
    await Bun.sleep(2000);
  }
  return { idle: false, found: foundMarker };
}

// ─── TEST CASES ───

interface TestCase {
  name: string;
  message: string;
  expectInPane: string;
  timeoutMs?: number;
}

// Each message asks Claude to include a unique marker in its response
const testCases: TestCase[] = [
  {
    name: 'Short message',
    message:
      'What is 2+2? Reply with ONLY this format: "RESULT-SHORT: <number>"',
    expectInPane: 'RESULT-SHORT',
  },
  {
    name: 'Medium message (100+ chars)',
    message:
      'Count the number of exported functions in src/tmux/index.ts. Reply with ONLY this format: "RESULT-MEDIUM: <count> functions". Do not include any other text.',
    expectInPane: 'RESULT-MEDIUM',
  },
  {
    name: 'Long message (200+ chars, typical crew task)',
    message:
      '[lead-1@frontend]: This is a simulated crew task message. I need you to read the file src/tmux/index.ts and tell me what constant value is used for PASTE_SETTLE_MS. Reply with ONLY this format: "RESULT-LONG: <value>ms". Do not include any other text or explanation. This is important for verifying our send reliability fix.',
    expectInPane: 'RESULT-LONG',
  },
  {
    name: 'Multiline message (5 lines)',
    message: `[lead-1@frontend]: Answer these questions.
1. What is the capital of Japan?
2. What is 7 * 8?
3. Include the marker "RESULT-MULTI" in your answer.
Reply briefly, one line per question.`,
    expectInPane: 'RESULT-MULTI',
  },
];

// ─── MAIN ───

console.log('\n═══ Claude Code Send Reliability UAT ═══');
console.log(`Target pane: ${paneId}`);
console.log();

// Verify Claude Code is idle before starting
const initialText = await capturePaneFull();
if (!initialText.includes('❯')) {
  console.error(
    'ERROR: Claude Code does not appear to be at the idle prompt (❯)',
  );
  process.exit(1);
}
console.log('Claude Code is idle at ❯ prompt. Starting tests...\n');

for (const tc of testCases) {
  console.log(`Test: ${tc.name}`);
  console.log(
    `  Message: "${tc.message.slice(0, 70)}${tc.message.length > 70 ? '...' : ''}"`,
  );
  console.log(
    `  Length: ${tc.message.length} chars, ${tc.message.split('\n').length} line(s)`,
  );

  // Send the message via our sendKeys function
  const result = await sendKeys(paneId, tc.message);
  assert(
    result.delivered,
    'sendKeys() returned delivered=true',
    result.delivered ? undefined : result.error,
  );

  if (!result.delivered) {
    console.log('  ⚠ Skipping — delivery failed\n');
    continue;
  }

  // Wait for Claude Code to process and respond
  console.log(`  Waiting for response marker "${tc.expectInPane}"...`);
  const { idle, found } = await waitForResponse(
    tc.expectInPane,
    tc.timeoutMs || 120_000,
  );

  if (!found && idle) {
    // Check if message is stuck in the input buffer (Enter didn't fire)
    const paneText = await capturePaneFull();
    const lines = paneText.split('\n');
    const promptLines = lines.filter((l) => l.includes('❯')).slice(-1);
    if (promptLines.length && promptLines[0].length > 5) {
      assert(
        false,
        'Enter key submitted the message',
        `Text stuck in input buffer: "${promptLines[0].slice(0, 80)}..."`,
      );
    } else {
      assert(
        false,
        `Response contains "${tc.expectInPane}"`,
        'Claude Code responded but marker not found (unexpected response format)',
      );
    }
  } else if (!found && !idle) {
    assert(false, 'Claude Code responded in time', 'Timed out');
    const debugText = await capturePaneFull();
    const lastLines = debugText.split('\n').slice(-10).join('\n');
    console.log(`  DEBUG:\n${lastLines}\n`);
    break;
  } else {
    assert(true, 'Enter key submitted the message');
    assert(true, `Response contains "${tc.expectInPane}"`);
  }

  console.log();
}

// ─── Summary ───
console.log(`═══ Results: ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
