import { capturePane, isPaneDead } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';
import type { Agent, AgentStatus } from '../shared/types.ts';

export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  summary?: string;
}

function truncateLine(line: string, max: number = 100): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function extractSummary(output: string): string | undefined {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return undefined;

  const preferred = lines.filter(line =>
    /working on|editing/i.test(line) ||
    /(?:^|[\s./])[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/.test(line) ||
    /src\/|test\/|docs\/|skills\//.test(line)
  );

  const picked = (preferred.length > 0 ? preferred : lines.slice(-1))
    .slice(-3)
    .map(line => truncateLine(line));

  return picked.join('\n');
}

export class StatusPoller {
  private statuses = new Map<string, AgentStatusEntry>();

  get all(): Map<string, AgentStatusEntry> { return this.statuses; }

  getStatus(name: string): AgentStatusEntry {
    return this.statuses.get(name) ?? { status: 'unknown', lastChange: Date.now() };
  }

  async pollAll(agents: Record<string, Agent>): Promise<void> {
    for (const [name, agent] of Object.entries(agents)) {
      const prev = this.statuses.get(name);
      const entry = await this.pollOne(agent);

      if (prev && prev.status !== entry.status) {
        entry.lastChange = Date.now();
      } else if (prev) {
        entry.lastChange = prev.lastChange;
      }
      this.statuses.set(name, entry);
    }

    for (const name of this.statuses.keys()) {
      if (!agents[name]) this.statuses.delete(name);
    }
  }

  private async pollOne(agent: Agent): Promise<AgentStatusEntry> {
    try {
      if (await isPaneDead(agent.tmux_target)) {
        return { status: 'dead', lastChange: Date.now() };
      }
      const output = await capturePane(agent.tmux_target);
      if (output === null) return { status: 'unknown', lastChange: Date.now() };
      return { status: matchStatusLine(output), lastChange: Date.now(), summary: extractSummary(output) };
    } catch {
      return { status: 'unknown', lastChange: Date.now() };
    }
  }
}
