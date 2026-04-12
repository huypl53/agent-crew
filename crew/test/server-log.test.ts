import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logServer, initServerLog } from '../src/shared/server-log.ts';

const TEST_DIR = join(tmpdir(), `crew-server-log-test-${process.pid}`);
const TEST_LOG = join(TEST_DIR, 'server.log');

describe('server-log', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    initServerLog(TEST_LOG);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('logServer creates log file and writes a line', () => {
    logServer('INFO', 'test message');
    expect(existsSync(TEST_LOG)).toBe(true);
    const content = readFileSync(TEST_LOG, 'utf8');
    expect(content).toContain('[INFO] test message');
  });

  test('logServer includes ISO timestamp', () => {
    logServer('START', 'startup');
    const content = readFileSync(TEST_LOG, 'utf8');
    // Should contain a timestamp like 2026-04-12T...
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('logServer appends multiple lines', () => {
    logServer('INFO', 'line one');
    logServer('WARN', 'line two');
    logServer('ERROR', 'line three');
    const content = readFileSync(TEST_LOG, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('line one');
    expect(lines[2]).toContain('line three');
  });

  test('file rotation truncates to last 500 lines when exceeding 1MB', () => {
    // Write enough lines to exceed 1MB
    const longLine = 'X'.repeat(2000); // 2KB per line
    // 600 lines * 2KB = 1.2MB > 1MB threshold
    for (let i = 0; i < 600; i++) {
      logServer('TEST', `line-${i} ${longLine}`);
    }
    const content = readFileSync(TEST_LOG, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    // After truncation, should have ≤ 500 lines
    expect(lines.length).toBeLessThanOrEqual(500);
    // Should keep the most recent lines (last ones written)
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain('line-599');
  });

  test('logServer never throws even with bad path', () => {
    // Re-init with unwritable path — should not throw
    initServerLog('/dev/null/impossible/path/server.log');
    expect(() => logServer('INFO', 'should not throw')).not.toThrow();
    // Restore
    initServerLog(TEST_LOG);
  });
});
