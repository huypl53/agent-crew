import { getAllAgents } from '../state/index.ts';
import { collectClaudeCodeTokens } from './claude-code.ts';
import { collectCodexTokens } from './codex.ts';

const COLLECT_INTERVAL_MS = 30_000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Run one collection cycle for all registered agents */
export async function collectAllTokens(): Promise<void> {
  const agents = getAllAgents();
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
    } catch (err) {
      // Log but don't crash the loop
      console.error(`Token collection failed for ${agent.name}:`, err);
    }
  });
  await Promise.all(promises);
}

/** Start the periodic token collection loop */
export function startTokenCollection(): void {
  if (intervalHandle) return; // already running
  collectAllTokens();
  intervalHandle = setInterval(collectAllTokens, COLLECT_INTERVAL_MS);
}

/** Stop the token collection loop */
export function stopTokenCollection(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
