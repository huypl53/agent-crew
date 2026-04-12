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
    const prev = statusesRef.current;
    const entries = Object.entries(agents);

    // Poll ALL agents in parallel — avoids 200ms+ sequential subprocess blocking
    const results = await Promise.all(entries.map(async ([name, agent]): Promise<[string, AgentStatusEntry, boolean]> => {
      const prevEntry = prev.get(name);
      try {
        if (await isPaneDead(agent.tmux_target)) {
          const entry: AgentStatusEntry = { status: 'dead', lastChange: prevEntry?.status !== 'dead' ? Date.now() : (prevEntry?.lastChange ?? Date.now()) };
          return [name, entry, prevEntry?.status !== 'dead'];
        }
        const output = await capturePane(agent.tmux_target);
        if (output === null) {
          return [name, prevEntry ?? { status: 'unknown', lastChange: Date.now() }, !prevEntry];
        }
        const status = matchStatusLine(output);
        const statusChanged = !prevEntry || prevEntry.status !== status;
        const outputChanged = prevEntry?.rawOutput !== output;
        if (statusChanged || outputChanged) {
          return [name, { status, lastChange: statusChanged ? Date.now() : prevEntry!.lastChange, rawOutput: output }, true];
        }
        return [name, prevEntry, false];
      } catch (e) {
        logError('status.pollOne', e);
        return [name, prevEntry ?? { status: 'unknown', lastChange: Date.now() }, !prevEntry];
      }
    }));

    const next = new Map<string, AgentStatusEntry>();
    let changed = false;
    for (const [name, entry, wasChanged] of results) {
      next.set(name, entry);
      if (wasChanged) changed = true;
    }
    if (changed || next.size !== prev.size) setStatuses(next);
  }, []);

  const getStatus = useCallback((name: string): AgentStatusEntry => {
    return statusesRef.current.get(name) ?? { status: 'unknown', lastChange: Date.now() };
  }, []);

  return { statuses, pollAll, getStatus };
}
