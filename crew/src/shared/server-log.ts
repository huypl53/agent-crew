import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';

const STATE_DIR = process.env.CREW_STATE_DIR ?? '/tmp/crew/state';
const LOG_PATH = `${STATE_DIR}/server.log`;
const MAX_BYTES = 1_000_000; // 1MB
const TRUNCATE_LINES = 500;

let _logPath = LOG_PATH;
const RECENT_LOG_WINDOW_MS = 30_000;
const recentLogMap = new Map<string, number>();
const suppressedLogCount = new Map<string, number>();

export function initServerLog(path?: string): void {
  _logPath = path ?? LOG_PATH;
  try {
    const dir = dirname(_logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // Invalid path — logging will silently fail
  }
}

export function logServer(level: string, msg: string): void {
  try {
    const now = Date.now();
    const dedupeKey = `${level}|${msg}`;
    const lastAt = recentLogMap.get(dedupeKey) ?? 0;
    if (now - lastAt < RECENT_LOG_WINDOW_MS) {
      suppressedLogCount.set(dedupeKey, (suppressedLogCount.get(dedupeKey) ?? 0) + 1);
      return;
    }

    const suppressed = suppressedLogCount.get(dedupeKey) ?? 0;
    if (suppressed > 0) {
      const summary = `${new Date().toISOString()} [${level}] ${msg} (suppressed ${suppressed} similar logs in ${RECENT_LOG_WINDOW_MS / 1000}s window)\n`;
      appendFileSync(_logPath, summary);
      suppressedLogCount.delete(dedupeKey);
    }

    recentLogMap.set(dedupeKey, now);
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    appendFileSync(_logPath, line);

    // Cap at 1MB — truncate to last 500 lines
    const size = (() => {
      try {
        return Bun.file(_logPath).size;
      } catch {
        return 0;
      }
    })();
    if (size > MAX_BYTES) {
      const content = readFileSync(_logPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      const kept = lines.slice(-TRUNCATE_LINES).join('\n') + '\n';
      writeFileSync(_logPath, kept);
    }
  } catch {
    // Never throw from a logger
  }
}
