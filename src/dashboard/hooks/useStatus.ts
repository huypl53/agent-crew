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
    const next = new Map<string, AgentStatusEntry>();
    let changed = false;
    for (const [name, agent] of Object.entries(agents)) {
      const prevEntry = prev.get(name);
      try {
        if (await isPaneDead(agent.tmux_target)) {
          const entry: AgentStatusEntry = { status: 'dead', lastChange: prevEntry?.status !== 'dead' ? Date.now() : (prevEntry?.lastChange ?? Date.now()) };
          next.set(name, entry);
          if (prevEntry?.status !== 'dead') changed = true;
          continue;
        }
        const output = await capturePane(agent.tmux_target);
        if (output === null) {
          next.set(name, prevEntry ?? { status: 'unknown', lastChange: Date.now() });
          if (!prevEntry) changed = true;
          continue;
        }
        const status = matchStatusLine(output);
        const statusChanged = !prevEntry || prevEntry.status !== status;
        const outputChanged = prevEntry?.rawOutput !== output;
        if (statusChanged || outputChanged) {
          next.set(name, { status, lastChange: statusChanged ? Date.now() : prevEntry!.lastChange, rawOutput: output });
          changed = true;
        } else {
          next.set(name, prevEntry);
        }
      } catch (e) {
        logError('status.pollOne', e);
        next.set(name, prevEntry ?? { status: 'unknown', lastChange: Date.now() });
        if (!prevEntry) changed = true;
      }
    }
    // Only update state if something actually changed
    if (changed || next.size !== prev.size) setStatuses(next);
  }, []);

  const getStatus = useCallback((name: string): AgentStatusEntry => {
    return statusesRef.current.get(name) ?? { status: 'unknown', lastChange: Date.now() };
  }, []);

  return { statuses, pollAll, getStatus };
}
