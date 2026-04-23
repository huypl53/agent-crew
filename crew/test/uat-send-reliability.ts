#!/usr/bin/env bun
/**
 * UAT: Send reliability test — verifies that sendKeys delivers text + Enter
 * correctly for short, long, and multiline payloads.
 *
 * Tests against a bash shell pane to verify the full text arrives and Enter
 * submits it (the shell echoes back the input line).
 *
 * Usage: bun test/uat-send-reliability.ts
 */
import { capturePane, paneExists, sendKeys } from '../src/tmux/index.ts';

const SESSION = 'uat-send-rel';
const PANES: string[] = [];
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

async function runTmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux ${args.join(' ')} failed: ${stderr}`);
  }
  return out.trimEnd();
}

async function createPane(): Promise<string> {
  if (PANES.length === 0) {
    const pane = await runTmux(
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-x',
      '200',
      '-y',
      '50',
      '-P',
      '-F',
      '#{pane_id}',
    );
    PANES.push(pane);
    return pane;
  }
  const pane = await runTmux(
    'split-window',
    '-t',
    SESSION,
    '-P',
    '-F',
    '#{pane_id}',
  );
  PANES.push(pane);
  return pane;
}

async function waitForPrompt(pane: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await capturePane(pane);
    if (text && text.includes('$')) return;
    await Bun.sleep(100);
  }
}

async function captureFull(pane: string): Promise<string> {
  const proc = Bun.spawn(
    ['tmux', 'capture-pane', '-p', '-J', '-t', pane, '-S', '-100'],
    { stdout: 'pipe' },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

async function cleanup() {
  try {
    await runTmux('kill-session', '-t', SESSION);
  } catch {
    /* ignore */
  }
}

// ─── TEST CASES ───

interface TestCase {
  name: string;
  text: string;
  // substring we expect to find in pane output after the echo command runs
  expect: string;
}

const shortText = '[lead-1@frontend]: Build login page';
const longText = '[lead-1@frontend]: ' + 'A'.repeat(300) + ' end-marker-long';
const multilineText = `[lead-1@frontend]: Task description
Line 2 of the task
Line 3 with details
Line 4 more details
Line 5 even more
Line 6 requirements
Line 7 acceptance criteria
Line 8 edge cases
Line 9 testing notes
Line 10 final line end-marker-multi`;

const specialCharsText = `[system@room]: Status report: "done" & 'ok' | $(not-expanded) \`backticks\` end-marker-special`;

const testCases: TestCase[] = [
  {
    name: 'Short single-line text',
    text: shortText,
    expect: 'Build login page',
  },
  {
    name: 'Long single-line text (300+ chars)',
    text: longText,
    expect: 'end-marker-long',
  },
  {
    name: 'Multiline text (10 lines)',
    text: multilineText,
    expect: 'end-marker-multi',
  },
  {
    name: 'Text with special characters',
    text: specialCharsText,
    expect: 'end-marker-special',
  },
];

// ─── MAIN ───

console.log('\n═══ Send Reliability UAT ═══\n');

await cleanup();

try {
  // Each test case gets its own pane with a bash shell that echoes received input
  for (const tc of testCases) {
    console.log(`\nTest: ${tc.name}`);

    const pane = await createPane();
    assert(await paneExists(pane), `Pane ${pane} created`);

    // Wait for shell prompt
    await waitForPrompt(pane);

    // Set up: use cat so the pane just shows whatever text arrives followed by Enter
    // We use 'echo' style: the shell will try to run the text as a command,
    // which will fail, but the text will appear in the pane output
    const result = await sendKeys(pane, tc.text);
    assert(result.delivered, `sendKeys returned delivered=true`);

    // Wait for the text to appear and shell to process
    await Bun.sleep(500);

    const paneText = await captureFull(pane);

    // The text should appear in the pane (either as typed input or in error output)
    assert(
      paneText.includes(tc.expect),
      `Pane contains expected marker "${tc.expect}"`,
      paneText.includes(tc.expect)
        ? undefined
        : `Pane text:\n${paneText.slice(-500)}`,
    );

    // Verify Enter was processed: look for shell response after the text.
    // Shell-agnostic: check for error output, prompt chars, or any new output.
    const afterText = paneText.split(tc.expect).pop() || '';
    const enterProcessed =
      afterText.includes('not found') ||
      afterText.includes('No such file') ||
      afterText.includes('no matches found') ||
      afterText.includes('$') ||
      afterText.includes('❯') ||
      afterText.includes('>') ||
      afterText.includes('#');
    assert(
      enterProcessed,
      'Enter was processed (shell responded after text)',
      enterProcessed ? undefined : `After marker:\n${afterText.slice(0, 300)}`,
    );
  }

  // ─── Rapid-fire test: send multiple messages to same pane quickly ───
  console.log('\nTest: Rapid-fire (3 messages to same pane)');
  const rapidPane = await createPane();
  await waitForPrompt(rapidPane);

  const msgs = [
    '[agent-1@room]: First message marker-rapid-1',
    '[agent-2@room]: Second message marker-rapid-2',
    '[agent-3@room]: Third message marker-rapid-3',
  ];

  for (const msg of msgs) {
    const r = await sendKeys(rapidPane, msg);
    assert(r.delivered, `Rapid send delivered: ${msg.slice(0, 40)}...`);
  }

  await Bun.sleep(1000);
  const rapidText = await captureFull(rapidPane);

  assert(rapidText.includes('marker-rapid-1'), 'Rapid: msg 1 text arrived');
  assert(rapidText.includes('marker-rapid-2'), 'Rapid: msg 2 text arrived');
  assert(rapidText.includes('marker-rapid-3'), 'Rapid: msg 3 text arrived');

  // All three should have been submitted — count shell responses (errors or prompts)
  const shellResponses = (
    rapidText.match(/no matches found|not found|No such file/g) || []
  ).length;
  assert(
    shellResponses >= 3,
    `Rapid: ${shellResponses} shell responses (>= 3 = all submitted)`,
    shellResponses < 3 ? `Pane:\n${rapidText.slice(-600)}` : undefined,
  );
} finally {
  console.log('\n─── Cleanup ───');
  await cleanup();
}

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
