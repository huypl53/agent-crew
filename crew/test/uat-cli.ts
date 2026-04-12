#!/usr/bin/env bun
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Isolated state dir so UAT doesn't touch the live DB
const stateDir = join(tmpdir(), `crew-uat-cli-${Date.now()}`);
mkdirSync(stateDir, { recursive: true });

const CWD = import.meta.dir.replace(/\/test$/, '');
const CLI = ['bun', 'src/cli.ts'];
const ENV = { ...process.env, CREW_STATE_DIR: stateDir };

let passed = 0, failed = 0;

async function run(label: string, args: string[], check: (out: string) => boolean) {
  try {
    const proc = Bun.spawn([...CLI, ...args], {
      stdout: 'pipe', stderr: 'pipe', cwd: CWD, env: ENV,
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    const combined = out + err;
    if (check(combined)) {
      console.log(`✓ ${label}`);
      passed++;
    } else {
      console.log(`✗ ${label} — got: ${combined.slice(0, 200)}`);
      failed++;
    }
  } catch (e: any) {
    console.log(`✗ ${label} — error: ${e.message?.slice(0, 100)}`);
    failed++;
  }
}

// Get a real tmux pane for join (required by handler)
const paneProc = Bun.spawn(['tmux', 'list-panes', '-a', '-F', '#{pane_id}'], {
  stdout: 'pipe', stderr: 'pipe',
});
const paneOut = await new Response(paneProc.stdout).text();
await paneProc.exited;
const PANE = paneOut.trim().split('\n')[0] ?? '%0';

console.log(`=== CLI UAT === (state: ${stateDir}, pane: ${PANE})\n`);

// 1. Help — contains "Usage" and "crew"
await run('crew help', ['help'],
  o => o.includes('Usage') && o.includes('crew'));

// 2. Rooms (fresh DB — empty)
await run('crew rooms (empty)', ['rooms'],
  o => o.includes('(no rooms)'));

// 3. Join — formatter: "Joined uat-test as uat-bot (worker) pane:..."
await run('crew join', ['join', '--room', 'uat-test', '--role', 'worker', '--name', 'uat-bot', '--pane', PANE],
  o => o.includes('uat-bot') && o.includes('uat-test'));

// 4. Members — formatter: "[uat-test]\n  uat-bot worker ..."
await run('crew members', ['members', '--room', 'uat-test'],
  o => o.includes('[uat-test]') && o.includes('uat-bot'));

// 5. Send directed to self (pull mode avoids tmux delivery; broadcast would have 0 recipients)
// formatter: "msg:${id} queued"
await run('crew send', ['send', '--room', 'uat-test', '--to', 'uat-bot', '--text', 'hello UAT', '--name', 'uat-bot', '--mode', 'pull'],
  o => o.includes('msg:'));

// 6. Read — formatter: "[uat-bot@uat-test]: hello UAT"
await run('crew read', ['read', '--name', 'uat-bot', '--room', 'uat-test'],
  o => o.includes('hello UAT'));

// 7. Status — formatter: "uat-bot ${status} ${pane} ${rooms}"
await run('crew status', ['status', 'uat-bot'],
  o => o.includes('uat-bot') && o.includes('uat-test'));

// 8. Check — formatter: "messages:N tasks:N"
await run('crew check', ['check', '--name', 'uat-bot'],
  o => o.includes('messages:') || o.includes('tasks:'));

// 9. Search tasks (no tasks yet)
await run('crew search-tasks', ['search-tasks', '--room', 'uat-test'],
  o => o.includes('(no tasks found)') || o.includes('#'));

// 10. Rooms --json (uat-test should appear as valid JSON)
await run('crew rooms --json', ['rooms', '--json'],
  o => { try { const d = JSON.parse(o); return Array.isArray(d.rooms) && d.rooms.some((r: any) => r.name === 'uat-test'); } catch { return false; } });

// 11. Leave — formatter: "Left room"
await run('crew leave', ['leave', '--room', 'uat-test', '--name', 'uat-bot'],
  o => o.includes('Left room'));

// 12. Unknown command — stderr: "Unknown command: blahblah..."
await run('crew unknown (error)', ['blahblah'],
  o => o.toLowerCase().includes('unknown'));

// Cleanup
rmSync(stateDir, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
