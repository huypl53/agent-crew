import { useState, useCallback, useRef } from 'react';
import { capturePane, isPaneDead } from '../../tmux/index.ts';
import { matchStatusLine } from '../../shared/status-patterns.ts';
import type { Agent, AgentStatus } from '../../shared/types.ts';
import { logError } from '../logger.ts';

export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  rawOutput?: string;
}

export function useStatus() {
  const [statuses, setStatuses] = useState<Map<string, AgentStatusEntry>>(new Map());
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const pollAll = useCallback(async (agents: Record<string, Agent>) => {
    const next = new Map<string, AgentStatusEntry>();
    for (const [name, agent] of Object.entries(agents)) {
      const prev = statusesRef.current.get(name);
      try {
        if (await isPaneDead(agent.tmux_target)) {
          next.set(name, { status: 'dead', lastChange: prev?.status !== 'dead' ? Date.now() : (prev?.lastChange ?? Date.now()) });
          continue;
        }
        const output = await capturePane(agent.tmux_target);
        if (output === null) {
          next.set(name, { status: 'unknown', lastChange: prev?.lastChange ?? Date.now() });
          continue;
        }
        const status = matchStatusLine(output);
        const changed = !prev || prev.status !== status;
        next.set(name, { status, lastChange: changed ? Date.now() : prev!.lastChange, rawOutput: output });
      } catch (e) {
        logError('status.pollOne', e);
        next.set(name, { status: 'unknown', lastChange: prev?.lastChange ?? Date.now() });
      }
    }
    setStatuses(next);
  }, []);

  const getStatus = useCallback((name: string): AgentStatusEntry => {
    return statusesRef.current.get(name) ?? { status: 'unknown', lastChange: Date.now() };
  }, []);

  return { statuses, pollAll, getStatus };
}
