import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';
import type { ViewName } from '../hooks/useViews.ts';
import type { Message, Task, TokenUsage } from '../../shared/types.ts';

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface HeaderStatsProps {
  currentView: ViewName;
  statuses: Map<string, AgentStatusEntry>;
  messages: Message[];
  tasks: Task[];
  tokenUsage: TokenUsage[];
  earliestJoinedAt: string | null;
  cols: number;
}

export const HeaderStats = memo(function HeaderStats({ currentView, statuses, messages, tasks, tokenUsage, earliestJoinedAt, cols }: HeaderStatsProps) {
  const stats = useMemo(() => {
    let busy = 0, idle = 0, dead = 0;
    for (const entry of statuses.values()) {
      if (entry.status === 'busy') busy++;
      else if (entry.status === 'idle') idle++;
      else if (entry.status === 'dead') dead++;
    }

    let active = 0, queued = 0, done = 0, errors = 0;
    for (const t of tasks) {
      if (t.status === 'active') active++;
      else if (t.status === 'queued' || t.status === 'sent') queued++;
      else if (t.status === 'completed') done++;
      else if (t.status === 'error') errors++;
    }

    let uptime = '';
    if (earliestJoinedAt) {
      const secs = Math.floor((Date.now() - new Date(earliestJoinedAt).getTime()) / 1000);
      if (secs < 60) uptime = `${secs}s`;
      else if (secs < 3600) uptime = `${Math.floor(secs / 60)}m`;
      else {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        uptime = m > 0 ? `${h}h${m}m` : `${h}h`;
      }
    }

    return { busy, idle, dead, active, queued, done, errors, uptime };
  }, [statuses, tasks, earliestJoinedAt]);

  // Deduplicate: latest snapshot per agent (tokenUsage is sorted DESC by recorded_at)
  const latestByAgent = new Map<string, TokenUsage>();
  for (const t of tokenUsage) {
    if (!latestByAgent.has(t.agent_name)) {
      latestByAgent.set(t.agent_name, t);
    }
  }
  const totalCost = [...latestByAgent.values()].reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
  const totalTokens = [...latestByAgent.values()].reduce((sum, t) => sum + t.input_tokens + t.output_tokens, 0);

  const viewTabs = (
    <Text>
      {(['dashboard', 'tasks', 'timeline'] as const).map(v => (
        <Text key={v} color={v === currentView ? 'cyan' : 'gray'} bold={v === currentView}>
          {` [${v === 'dashboard' ? 'Dashboard' : v === 'tasks' ? 'Tasks' : 'Timeline'}] `}
        </Text>
      ))}
      <Text dimColor> Tab to switch</Text>
    </Text>
  );

  const compact = cols < 100;

  if (compact) {
    return (
      <Box height={1} width={cols}>
        {viewTabs}
      </Box>
    );
  }

  return (
    <Box height={2} width={cols} flexDirection="column">
      <Box height={1} width={cols}>
        {viewTabs}
      </Box>
      <Box height={1} width={cols}>
        <Text>
          <Text dimColor> Agents: </Text>
          <Text color="yellow">{stats.busy}</Text><Text dimColor> busy  </Text>
          <Text color="green">{stats.idle}</Text><Text dimColor> idle</Text>
          {stats.dead > 0 && <><Text dimColor>  </Text><Text color="red">{stats.dead}</Text><Text dimColor> dead</Text></>}
          <Text dimColor> │ Tasks: </Text>
          <Text color="green">{stats.done}</Text><Text dimColor> done</Text>
          {stats.active > 0 && <><Text dimColor>  </Text><Text color="yellow">{stats.active}</Text><Text dimColor> active</Text></>}
          {stats.queued > 0 && <><Text dimColor>  </Text><Text>{stats.queued}</Text><Text dimColor> queued</Text></>}
          {stats.errors > 0 && <><Text dimColor>  </Text><Text color="red">{stats.errors}</Text><Text dimColor> err</Text></>}
          {stats.uptime && <><Text dimColor> │ Up: </Text><Text dimColor>{stats.uptime}</Text></>}
          <Text dimColor> │ Cost: </Text>
          <Text color="green">${totalCost.toFixed(2)}</Text>
          <Text dimColor> ({formatTokenCount(totalTokens)} tok)</Text>
        </Text>
      </Box>
    </Box>
  );
});
