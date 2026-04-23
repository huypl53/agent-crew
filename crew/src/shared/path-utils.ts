import { realpathSync } from 'fs';
import { resolve } from 'path';

export function normalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(p);
  } catch {
    resolved = resolve(p);
  }
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}
