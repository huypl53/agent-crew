import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export const LOG_PATH = '/tmp/crew/dashboard.log';
let errorCount = 0;

export function logError(ctx: string, err: unknown): void {
  errorCount++;
  const msg = err instanceof Error ? err.message : String(err);
  const line = `${new Date().toISOString()} [${ctx}] ${msg}\n`;
  try {
    const dir = dirname(LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(LOG_PATH, line);
  } catch { /* nowhere to report */ }
}

export function hasErrors(): boolean { return errorCount > 0; }
export function resetErrors(): void { errorCount = 0; }
