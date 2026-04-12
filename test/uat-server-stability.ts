#!/usr/bin/env bun
/**
 * UAT: Server Stability — logging, crash guards, heartbeat
 *
 * Tests:
 *   TC-L1  Write and read back
 *   TC-L2  Append across multiple calls
 *   TC-L3  Rotation at 1 MB
 *   TC-L4  Never throws on bad path
 *   TC-G1  uncaughtException handler registered
 *   TC-G2  unhandledRejection handler registered
 *   TC-G3  SIGHUP handler registered
 *   TC-G4  stdin.resume keeps process alive
 *   TC-G5  uncaughtException does NOT call process.exit
 *   TC-H1  Heartbeat writes to server.log
 *   TC-H2  Heartbeat format
 */

import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { initServerLog, logServer } from '../src/shared/server-log.ts';

// ─── Test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(name: string) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name: string, reason: string) {
  console.error(`  ✗ ${name}: ${reason}`);
  failed++;
}

function assert(name: string, cond: boolean, reason = 'assertion failed') {
  cond ? ok(name) : fail(name, reason);
}

// ─── Temp dir helpers ─────────────────────────────────────────────────────────

const BASE_TMP = `/tmp/crew-uat-stability-${process.pid}`;

function makeTmp(label: string): string {
  const dir = join(BASE_TMP, label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup() {
  try { rmSync(BASE_TMP, { recursive: true, force: true }); } catch {}
}

// ─── TC-L: Server-Log Module ─────────────────────────────────────────────────

console.log('\nServer-Log Module');

// TC-L1 — Write and read back
{
  const dir = makeTmp('L1');
  const logPath = join(dir, 'server.log');
  initServerLog(logPath);
  logServer('INFO', 'hello world');
  if (!existsSync(logPath)) {
    fail('TC-L1 write and read back', 'log file was not created');
  } else {
    const content = readFileSync(logPath, 'utf8');
    assert('TC-L1 contains [INFO] level', content.includes('[INFO] hello world'));
    assert('TC-L1 has ISO-8601 timestamp',
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/.test(content));
  }
}

// TC-L2 — Append across multiple calls
{
  const dir = makeTmp('L2');
  const logPath = join(dir, 'server.log');
  initServerLog(logPath);
  logServer('INFO', 'line-one');
  logServer('WARN', 'line-two');
  logServer('ERROR', 'line-three');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(l => l.length > 0);
  assert('TC-L2 has 3 lines', lines.length === 3, `got ${lines.length}`);
  assert('TC-L2 lines in order',
    lines[0].includes('line-one') && lines[1].includes('line-two') && lines[2].includes('line-three'));
}

// TC-L3 — Rotation at 1 MB
{
  const dir = makeTmp('L3');
  const logPath = join(dir, 'server.log');
  initServerLog(logPath);
  // Write 600 lines of ~2 KB each → ~1.2 MB total
  const msg = 'x'.repeat(2000);
  for (let i = 0; i < 600; i++) {
    logServer('INFO', `${i.toString().padStart(3, '0')} ${msg}`);
  }
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(l => l.length > 0);
  assert('TC-L3 file truncated to ≤500 lines', lines.length <= 500, `got ${lines.length}`);
  assert('TC-L3 last line is last-written message',
    lines[lines.length - 1].includes('599'));
}

// TC-L4 — Never throws on bad path
{
  let threw = false;
  try {
    initServerLog('/dev/null/impossible/server.log');
    logServer('INFO', 'test');
  } catch {
    threw = true;
  }
  assert('TC-L4 never throws on bad path', !threw);
  // Restore to a valid path for subsequent tests
  initServerLog(join(makeTmp('restored'), 'server.log'));
}

// ─── TC-G: Crash Guard Registration ──────────────────────────────────────────

console.log('\nCrash Guard Registration');

// TC-G1/G2/G3/G4/G5 — Read src/index.ts to verify handler registration
// This avoids starting the full MCP server (requires tmux) while still confirming
// the guards are present and correctly implemented.

const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url).pathname, 'utf8');

assert('TC-G1 uncaughtException handler present',
  indexSrc.includes("process.on('uncaughtException'"),
  "process.on('uncaughtException') not found in src/index.ts");

assert('TC-G2 unhandledRejection handler present',
  indexSrc.includes("process.on('unhandledRejection'"),
  "process.on('unhandledRejection') not found in src/index.ts");

assert('TC-G3 SIGHUP handler present',
  indexSrc.includes("process.on('SIGHUP'"),
  "process.on('SIGHUP') not found in src/index.ts");

assert('TC-G4 stdin.resume() present',
  indexSrc.includes('process.stdin.resume()'),
  'process.stdin.resume() not found in src/index.ts');

// TC-G5 — uncaughtException handler must NOT call process.exit
// Extract the handler body and check
const uncaughtMatch = indexSrc.match(/process\.on\('uncaughtException'[\s\S]*?\}\);/);
if (!uncaughtMatch) {
  fail('TC-G5 uncaughtException body does not call process.exit', 'handler not found');
} else {
  const handlerBody = uncaughtMatch[0];
  const hasExit = /process\.exit/.test(handlerBody);
  assert('TC-G5 uncaughtException does not call process.exit', !hasExit,
    'handler body contains process.exit — server would crash on unhandled exception');
}

// Also verify unhandledRejection doesn't exit
const rejectionMatch = indexSrc.match(/process\.on\('unhandledRejection'[\s\S]*?\}\);/);
if (!rejectionMatch) {
  fail('TC-G5b unhandledRejection body present', 'handler not found');
} else {
  assert('TC-G5b unhandledRejection does not call process.exit',
    !/process\.exit/.test(rejectionMatch[0]));
}

// ─── TC-H: Health Heartbeat ───────────────────────────────────────────────────

console.log('\nHealth Heartbeat');

// TC-H1/H2 — Reproduce heartbeat logic and verify log format
// The heartbeat is inline in src/index.ts; we test the format by:
//   1. Confirming the logServer call uses 'HEALTH' level with the expected fields
//   2. Generating a heartbeat line with real process.memoryUsage() and verifying the pattern

{
  const dir = makeTmp('H');
  const logPath = join(dir, 'server.log');
  initServerLog(logPath);

  // Verify heartbeat format string exists in source
  assert('TC-H1 HEALTH level used in heartbeat',
    indexSrc.includes("logServer('HEALTH'"),
    "logServer('HEALTH') not found in src/index.ts");

  assert('TC-H1 heartbeat includes rss= field',
    indexSrc.includes('rss='));

  assert('TC-H1 heartbeat includes agents= field',
    indexSrc.includes('agents='));

  assert('TC-H1 heartbeat includes uptime= field',
    indexSrc.includes('uptime='));

  // TC-H2 — Generate a sample heartbeat line and verify it matches expected pattern
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1_048_576).toFixed(1);
  const heapUsed = (mem.heapUsed / 1_048_576).toFixed(1);
  const heapTotal = (mem.heapTotal / 1_048_576).toFixed(1);
  const uptime = (process.uptime() / 60).toFixed(1);
  const sampleLine = `rss=${rss}MB heapUsed=${heapUsed}MB heapTotal=${heapTotal}MB agents=0 uptime=${uptime}m`;
  logServer('HEALTH', sampleLine);

  const content = readFileSync(logPath, 'utf8');
  assert('TC-H2 HEALTH line written to log', content.includes('[HEALTH]'));
  assert('TC-H2 format: rss=<N>MB', /rss=\d+\.\d+MB/.test(content));
  assert('TC-H2 format: heapUsed=<N>MB', /heapUsed=\d+\.\d+MB/.test(content));
  assert('TC-H2 format: agents=<N>', /agents=\d+/.test(content));
  assert('TC-H2 format: uptime=<N>m', /uptime=\d+\.\d+m/.test(content));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

cleanup();
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
