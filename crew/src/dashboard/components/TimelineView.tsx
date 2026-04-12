import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Task, TaskEvent, Agent } from '../../shared/types.ts';

interface TimelineProps {
  tasks: Task[];
  taskEvents: TaskEvent[];
  agents: Agent[];
  height: number;
  width: number;
}

interface TimelineSegment {
  agentName: string;
  roomName: string;
  segments: Array<{ status: string; startMs: number; endMs: number; color: string; char: string }>;
}

export function TimelineView({ tasks, taskEvents, agents, height, width }: TimelineProps) {
  const [zoomLevel, setZoomLevel] = useState(1); // 1 = normal, 0.5 = zoomed in, 2 = zoomed out
  const [scrollOffsetY, setScrollOffsetY] = useState(0);
  const [scrollOffsetX, setScrollOffsetX] = useState(0);

  const agentMap = useMemo(() => new Map(agents.map(a => [a.name, a])), [agents]);

  // Get global time range from ALL tasks and events
  const timeRange = useMemo(() => {
    const times: number[] = [];
    for (const task of tasks) {
      times.push(new Date(task.created_at).getTime());
      times.push(new Date(task.updated_at).getTime());
    }
    for (const e of taskEvents) {
      times.push(new Date(e.timestamp).getTime());
    }
    if (times.length === 0) return { minMs: 0, maxMs: 0, rangeMs: 1 };
    const minMs = Math.min(...times);
    const maxMs = Math.max(...times);
    return { minMs, maxMs, rangeMs: Math.max(1, maxMs - minMs) };
  }, [tasks, taskEvents]);

  // Build timeline segments per agent
  const agentTimelines = useMemo(() => {
    const result: TimelineSegment[] = [];

    // Collect all agent names from both the agents list and tasks
    const allAgentNames = new Set<string>(agents.map(a => a.name));
    for (const task of tasks) {
      if (task.assigned_to) allAgentNames.add(task.assigned_to);
    }

    for (const agentName of Array.from(allAgentNames).sort()) {
      const agent = agentMap.get(agentName);
      const agentTasks = tasks.filter(t => t.assigned_to === agentName);
      if (agentTasks.length === 0) continue;

      const segments: TimelineSegment['segments'] = [];

      for (const task of agentTasks) {
        const events = taskEvents
          .filter(e => e.task_id === task.id)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        // Synthetic bar: if no events, use created_at to updated_at
        if (events.length === 0) {
          const startMs = new Date(task.created_at).getTime() - timeRange.minMs;
          const endMs = new Date(task.updated_at).getTime() - timeRange.minMs;
          // Always show at least a 1ms bar, even when timestamps are identical
          segments.push({ status: task.status, startMs, endMs: Math.max(endMs, startMs + 1), color: 'cyan', char: '░' });
          continue;
        }

        for (let i = 0; i < events.length - 1; i++) {
          const evt = events[i]!;
          const nextEvt = events[i + 1]!;
          const startMs = new Date(evt.timestamp).getTime() - timeRange.minMs;
          const endMs = new Date(nextEvt.timestamp).getTime() - timeRange.minMs;
          const status = evt.to_status;

          let color = 'gray';
          let char = '░';
          if (status === 'active') {
            color = 'yellow';
            char = '▓';
          } else if (status === 'completed') {
            color = 'green';
            char = '█';
          } else if (status === 'error') {
            color = 'red';
            char = '▒';
          } else if (status === 'interrupted') {
            color = 'magenta';
            char = '▒';
          } else if (status === 'queued' || status === 'sent') {
            color = 'cyan';
            char = '░';
          }

          segments.push({ status, startMs, endMs, color, char });
        }
      }

      const roomName = agent?.rooms[0] ?? 'unknown';
      result.push({ agentName, roomName, segments });
    }

    return result;
  }, [tasks, taskEvents, agents, agentMap, timeRange]);

  // Calculate bar width in columns
  const barWidth = Math.max(20, Math.floor(width * 0.8));
  const timePerCol = (timeRange.rangeMs / barWidth) * zoomLevel;

  // Render timeline bar for an agent
  const renderBar = (segments: TimelineSegment['segments']): string => {
    const bar: string[] = Array(barWidth).fill(' ');
    for (const seg of segments) {
      const startCol = Math.floor(seg.startMs / timePerCol);
      const endCol = Math.ceil(seg.endMs / timePerCol);
      for (let col = startCol; col < endCol && col < barWidth; col++) {
        if (col >= 0) bar[col] = seg.char;
      }
    }
    return bar.join('');
  };

  // Format time label
  const formatTime = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}m${remSecs}s`;
  };

  useInput((input, key) => {
    if (input === '+') {
      setZoomLevel(prev => Math.max(0.25, prev * 0.8));
      return;
    }
    if (input === '-') {
      setZoomLevel(prev => Math.min(4, prev * 1.2));
      return;
    }
    if (input === 'j' || key.downArrow) {
      setScrollOffsetY(prev => Math.min(prev + 1, Math.max(0, agentTimelines.length - Math.floor(height * 0.8))));
      return;
    }
    if (input === 'k' || key.upArrow) {
      setScrollOffsetY(prev => Math.max(prev - 1, 0));
      return;
    }
    if (input === 'h' || key.leftArrow) {
      setScrollOffsetX(prev => Math.max(prev - 2, 0));
      return;
    }
    if (input === 'l' || key.rightArrow) {
      setScrollOffsetX(prev => Math.min(prev + 2, Math.max(0, barWidth - Math.floor(width * 0.7))));
      return;
    }
  });

  const visibleAgents = Math.max(1, height - 3);
  const visibleStart = scrollOffsetY;
  const visibleEnd = Math.min(agentTimelines.length, visibleStart + visibleAgents);
  const barStart = scrollOffsetX;
  const barEnd = Math.min(barWidth, barStart + Math.floor(width * 0.7));

  // Empty state
  if (agentTimelines.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height} justifyContent="center" alignItems="center">
        <Text dimColor>No task activity recorded yet</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Box height={1}>
        <Text dimColor>
          Timeline | Zoom: {zoomLevel.toFixed(2)}x | +/- to zoom | h/l to scroll | j/k for agents
        </Text>
      </Box>

      {/* Time axis */}
      <Box height={1}>
        <Text>
          <Text width={12}> </Text>
          {Array.from({ length: barEnd - barStart }, (_, i) => {
            const col = barStart + i;
            const timeMs = col * timePerCol;
            if (col % Math.ceil(barWidth / 10) === 0) {
              return (
                <Text key={col}>
                  {formatTime(timeMs + timeRange.minMs).padEnd(3).substring(0, 1)}
                </Text>
              );
            }
            return <Text key={col}>-</Text>;
          })}
        </Text>
      </Box>

      {/* Timeline bars */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {agentTimelines.slice(visibleStart, visibleEnd).map(timeline => {
          const bar = renderBar(timeline.segments);
          const visibleBar = bar.substring(barStart, barEnd);
          const label = `${timeline.roomName}/${timeline.agentName}`;
          return (
            <Box key={timeline.agentName} height={1}>
              <Text width={12}>{label.padEnd(12).substring(0, 12)}</Text>
              <Text>{visibleBar}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Status bar */}
      <Box height={1}>
        <Text dimColor>
          {visibleStart + 1}-{visibleEnd} of {agentTimelines.length} agents
        </Text>
      </Box>
    </Box>
  );
}
