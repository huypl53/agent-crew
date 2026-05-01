import { logServer } from '../shared/server-log.ts';
import { getAllAgents } from '../state/index.ts';
import { collectClaudeCodeTokens } from './claude-code.ts';
import { collectCodexTokens } from './codex.ts';

const COLLECT_INTERVAL_MS = 30_000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Run one collection cycle for all registered agents */
export async function collectAllTokens(): Promise<void> {
  let agents;
  try {
    agents = getAllAgents();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('DB not initialized')) {
      logServer('WARN', 'Token collection skipped: DB not initialized yet');
      return;
    }
    throw e;
  }
  const promises = agents.map(async (agent) => {
    try {
      switch (agent.agent_type) {
        case 'claude-code':
          await collectClaudeCodeTokens(agent.name, agent.tmux_target);
          break;
        case 'codex':
          collectCodexTokens(agent.name);
          break;
        case 'unknown':
          // Try both — Claude Code first (more common), Codex as fallback
          await collectClaudeCodeTokens(agent.name, agent.tmux_target);
          collectCodexTokens(agent.name);
          break;
      }
    } catch (e) {
      // Log but don't crash the loop
      const msg = e instanceof Error ? e.message : String(e);
      logServer('ERROR', `Token collection failed for ${agent.name}: ${msg}`);
      console.error(`Token collection failed for ${agent.name}:`, e);
    }
  });
  await Promise.all(promises);
}

/** Start the periodic token collection loop */
export function startTokenCollection(): void {
  if (intervalHandle) return; // already running
  collectAllTokens().catch((e) => {
    logServer(
      'ERROR',
      `Token collection first-run failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
  intervalHandle = setInterval(() => {
    collectAllTokens().catch((e) => {
      logServer(
        'ERROR',
        `Token collection interval failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }, COLLECT_INTERVAL_MS);
}

/** Stop the token collection loop */
export function stopTokenCollection(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
