import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CREW_HOOK_COMMAND = 'crew hook-event || true';
const HOOK_EVENTS = ['Stop', 'UserPromptSubmit', 'StopFailure'] as const;

function makeHookEntry(): { matcher: string; hooks: Array<{ type: string; command: string }> } {
  return { matcher: '', hooks: [{ type: 'command', command: CREW_HOOK_COMMAND }] };
}

export function buildHookSettings(): Record<string, unknown> {
  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [makeHookEntry()];
  }
  return { hooks };
}

export async function installHooks(cwd: string): Promise<void> {
  if (!existsSync(cwd)) return;

  const claudeDir = join(cwd, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<
    string,
    Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
  >;

  let changed = false;
  for (const event of HOOK_EVENTS) {
    const existing = hooks[event] ?? [];
    const alreadyInstalled = existing.some((entry) =>
      entry.hooks.some((h) => h.command.includes('crew hook-event')),
    );
    if (!alreadyInstalled) {
      existing.push(makeHookEntry());
      hooks[event] = existing;
      changed = true;
    }
  }

  if (changed) {
    settings.hooks = hooks;
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}
