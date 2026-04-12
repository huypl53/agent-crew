import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../hooks/useTree.ts';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';
import type { Message, Task, TokenUsage } from '../../shared/types.ts';

const STATUS_COLORS: Record<string, string> = {
  idle: 'green', busy: 'yellow', dead: 'red', unknown: 'gray',
};

interface TreePanelProps {
  nodes: TreeNode[];
  selectedIndex: number;
  height: number;
  width: number;
  statuses: Map<string, AgentStatusEntry>;
  messages: Message[];
  tasks: Task[];
  tokenUsage: TokenUsage[];
}

const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const SPARK_BUCKETS = 10;
const BUCKET_MS = 60_000; // 1 minute per bucket

export const TreePanel = memo(function TreePanel({ nodes, selectedIndex, height, width, statuses, messages, tasks, tokenUsage }: TreePanelProps) {
  const taskCounts = useMemo(() => {
    const counts = new Map<string, { active: number; queued: number }>();
    for (const t of tasks) {
      if (t.status !== 'active' && t.status !== 'queued' && t.status !== 'sent') continue;
      const c = counts.get(t.assigned_to) ?? { active: 0, queued: 0 };
      if (t.status === 'active') c.active++;
      else c.queued++;
      counts.set(t.assigned_to, c);
    }
    return counts;
  }, [tasks]);

  const errorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (m.kind === 'error') {
        counts.set(m.from, (counts.get(m.from) ?? 0) + 1);
      }
    }
    return counts;
  }, [messages]);

  const sparklines = useMemo(() => {
    const now = Date.now();
    const windowStart = now - SPARK_BUCKETS * BUCKET_MS;
    const lines = new Map<string, string>();

    // Bucket message counts per agent
    const agentBuckets = new Map<string, number[]>();
    for (const m of messages) {
      const ts = new Date(m.timestamp).getTime();
      if (ts < windowStart) continue;
      const bucket = Math.min(SPARK_BUCKETS - 1, Math.floor((ts - windowStart) / BUCKET_MS));
      const sender = m.from;
      if (!agentBuckets.has(sender)) agentBuckets.set(sender, new Array(SPARK_BUCKETS).fill(0));
      agentBuckets.get(sender)![bucket]++;
    }

    // Convert to sparkline strings
    for (const [agent, buckets] of agentBuckets) {
      const max = Math.max(...buckets, 1); // avoid division by zero
      const spark = buckets.map(v => SPARK_CHARS[Math.floor((v / max) * (SPARK_CHARS.length - 1))]!).join('');
      lines.set(agent, spark);
    }

    return lines;
  }, [messages]);

  const costByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tokenUsage) {
      if (!map.has(t.agent_name)) {
        map.set(t.agent_name, t.cost_usd ?? 0);
      }
    }
    return map;
  }, [tokenUsage]);
  const maxLines = Math.max(1, height - 2); // border top/bottom
  let startIdx = 0;
  if (selectedIndex >= maxLines) startIdx = selectedIndex - maxLines + 1;
  const visible = nodes.slice(startIdx, startIdx + maxLines);

  return (
    <Box flexDirection="column" borderStyle="single" width={width} height={height}>
      {visible.map((node, i) => {
        const globalIdx = startIdx + i;
        const isSel = globalIdx === selectedIndex;

        if (node.type === 'room') {
          return (
            <Text key={node.id} inverse={isSel}>
              {' '}{node.collapsed ? '▶' : '▼'} {node.label} ({node.memberCount})
            </Text>
          );
        }

        const agentStatus = node.agentName ? statuses.get(node.agentName)?.status ?? 'unknown' : 'unknown';
        const color = STATUS_COLORS[agentStatus] ?? 'gray';
        const dot = node.secondary ? '◦' : '●';
        const roleSuffix = node.role ? ` (${node.role})` : '';
        const errCount = node.agentName ? errorCounts.get(node.agentName) ?? 0 : 0;

        const innerW = width - 2; // account for border
        const spark = node.agentName ? sparklines.get(node.agentName) ?? '' : '';
        const baseLen = 3 + 1 + 1 + node.label.length; // indent + dot + space + name
        const roleLen = roleSuffix.length;
        const errLen = errCount > 0 ? ` [${errCount}!]`.length : 0;
        const sparkLen = spark.length > 0 ? spark.length + 1 : 0; // +1 for space

        // Decide: show role + sparkline, just sparkline, or just role
        const showSpark = sparkLen > 0 && (baseLen + sparkLen + errLen <= innerW);
        const showRole = baseLen + roleLen + (showSpark ? sparkLen : 0) + errLen <= innerW;

        return (
          <Text key={node.id} inverse={isSel} dimColor={node.secondary}>
            {'   '}<Text color={node.secondary ? 'gray' : color}>{dot}</Text> {node.label}
            {showRole && <Text dimColor>{roleSuffix}</Text>}
            {showSpark && <Text dimColor> {spark}</Text>}
            {errCount > 0 && <Text color="red"> [{errCount}!]</Text>}
            {(() => {
              const tc = node.agentName ? taskCounts.get(node.agentName) : undefined;
              if (!tc) return null;
              return (
                <>
                  {tc.active > 0 && <Text color="yellow"> ●{tc.active}</Text>}
                  {tc.queued > 0 && <Text dimColor> ◌{tc.queued}</Text>}
                </>
              );
            })()}
            {node.agentName && costByAgent.has(node.agentName) && (
              <Text dimColor> ${costByAgent.get(node.agentName)!.toFixed(2)}</Text>
            )}
          </Text>
        );
      })}
      {startIdx > 0 && <Text dimColor>{'  '}▲ more</Text>}
      {startIdx + maxLines < nodes.length && <Text dimColor>{'  '}▼ more</Text>}
    </Box>
  );
});
