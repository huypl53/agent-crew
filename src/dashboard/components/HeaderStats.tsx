import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';
import type { Message, Task } from '../../shared/types.ts';

interface HeaderStatsProps {
  statuses: Map<string, AgentStatusEntry>;
  messages: Message[];
  tasks: Task[];
  earliestJoinedAt: string | null;
  cols: number;
}

export const HeaderStats = memo(function HeaderStats({ statuses, messages, tasks, earliestJoinedAt, cols }: HeaderStatsProps) {
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

  const compact = cols < 100;

  if (compact) {
    return (
      <Box height={1} width={cols}>
        <Text>
          <Text color="yellow">{stats.busy}</Text>
          <Text dimColor>{'↑ '}</Text>
          <Text color="green">{stats.idle}</Text>
          <Text dimColor>{'○ '}</Text>
          {stats.dead > 0 && <><Text color="red">{stats.dead}</Text><Text dimColor>{'✗ '}</Text></>}
          <Text dimColor>{'│ '}</Text>
          <Text color="green">{stats.done}</Text>
          <Text dimColor>{'✓ '}</Text>
          {stats.active > 0 && <><Text color="yellow">{stats.active}</Text><Text dimColor>{'● '}</Text></>}
          {stats.queued > 0 && <><Text>{stats.queued}</Text><Text dimColor>{'◌ '}</Text></>}
          {stats.errors > 0 && <><Text color="red">{stats.errors}</Text><Text dimColor>{'! '}</Text></>}
          {stats.uptime && <><Text dimColor>{'│ '}</Text><Text dimColor>{stats.uptime}</Text></>}
        </Text>
      </Box>
    );
  }

  return (
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
      </Text>
    </Box>
  );
});
