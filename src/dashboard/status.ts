import { capturePane, isPaneDead } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';
import type { Agent, AgentStatus } from '../shared/types.ts';
import { logError } from './logger.ts';

export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  rawOutput?: string;
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
      return { status: matchStatusLine(output), lastChange: Date.now(), rawOutput: output };
    } catch (e) {
      logError('status.pollOne', e);
      return { status: 'unknown', lastChange: Date.now() };
    }
  }
}
