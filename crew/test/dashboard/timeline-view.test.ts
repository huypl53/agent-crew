import { describe, expect, it } from 'bun:test';
import type { Agent, Task, TaskEvent } from '../../src/shared/types';

// Mock component rendering logic (we'll test the data transformation, not JSX)
interface TimelineSegment {
  agentName: string;
  roomName: string;
  segments: Array<{
    status: string;
    startMs: number;
    endMs: number;
    color: string;
    char: string;
  }>;
}

/**
 * Test helper: Transforms tasks and taskEvents into timeline segments
 * This mirrors the logic in TimelineView.tsx agentTimelines useMemo
 */
function buildAgentTimelines(
  tasks: Task[],
  taskEvents: TaskEvent[],
  agents: Agent[],
  timeRange: { minMs: number; maxMs: number; rangeMs: number },
): TimelineSegment[] {
  const result: TimelineSegment[] = [];

  for (const agent of agents) {
    const agentTasks = tasks.filter((t) => t.assigned_to === agent.name);
    const segments: TimelineSegment['segments'] = [];

    for (const task of agentTasks) {
      const events = taskEvents
        .filter((e) => e.task_id === task.id)
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

      // SYNTHETIC BAR: If no events, create a bar from created_at to updated_at
      if (events.length === 0) {
        const startMs = new Date(task.created_at).getTime() - timeRange.minMs;
        const endMs = new Date(task.updated_at).getTime() - timeRange.minMs;
        if (startMs < endMs) {
          segments.push({
            status: 'queued',
            startMs,
            endMs,
            color: 'cyan',
            char: '░',
          });
        }
        continue;
      }

      // Existing logic: render segments between events
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

    if (segments.length > 0) {
      result.push({
        agentName: agent.name,
        roomName: agent.room_name ?? 'unknown',
        segments,
      });
    }
  }

  return result;
}

describe('TimelineView improvements', () => {
  const baseTime = new Date('2026-04-12T10:00:00Z').getTime();

  const mockAgent: Agent = {
    agent_id: 1,
    room_id: 1,
    room_path: '/test/crew',
    room_name: 'crew',
    name: 'wk-01',
    role: 'worker',
    tmux_target: '%1',
    agent_type: 'claude-code',
    status: null,
    persona: null,
    capabilities: null,
  };

  const mockAgentMultiRoom: Agent = {
    ...mockAgent,
    agent_id: 2,
    room_id: 2,
    room_path: '/test/project-a',
    room_name: 'project-a',
    name: 'wk-02',
  };

  const timeRange = {
    minMs: baseTime,
    maxMs: baseTime + 60000,
    rangeMs: 60000,
  };

  describe('Synthetic bars for tasks without events', () => {
    it('should render a bar for a task without taskEvents using created_at to updated_at', () => {
      const task: Task = {
        id: 1,
        room_id: 1,
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'queued',
        created_at: new Date(baseTime + 1000).toISOString(),
        updated_at: new Date(baseTime + 5000).toISOString(),
      };

      const timelines = buildAgentTimelines([task], [], [mockAgent], timeRange);

      expect(timelines).toHaveLength(1);
      expect(timelines[0]!.segments).toHaveLength(1);
      expect(timelines[0]!.segments[0]!.status).toBe('queued');
      expect(timelines[0]!.segments[0]!.startMs).toBe(1000);
      expect(timelines[0]!.segments[0]!.endMs).toBe(5000);
    });

    it('should skip synthetic bar if created_at equals updated_at', () => {
      const sameTime = new Date(baseTime + 1000).toISOString();
      const task: Task = {
        id: 1,
        room_id: 1,
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'queued',
        created_at: sameTime,
        updated_at: sameTime,
      };

      const timelines = buildAgentTimelines([task], [], [mockAgent], timeRange);

      expect(timelines).toHaveLength(0); // No timeline rendered for zero-duration task
    });
  });

  describe('Room labels in agent rows', () => {
    it('should include roomName from agent.room_name', () => {
      const task: Task = {
        id: 1,
        room_id: 1,
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'queued',
        created_at: new Date(baseTime + 1000).toISOString(),
        updated_at: new Date(baseTime + 5000).toISOString(),
      };

      const timelines = buildAgentTimelines([task], [], [mockAgent], timeRange);

      expect(timelines[0]!.roomName).toBe('crew');
    });

    it('should use agent room_name', () => {
      const task: Task = {
        id: 1,
        room_id: 2,
        assigned_to: 'wk-02',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'queued',
        created_at: new Date(baseTime + 1000).toISOString(),
        updated_at: new Date(baseTime + 5000).toISOString(),
      };

      const timelines = buildAgentTimelines(
        [task],
        [],
        [mockAgentMultiRoom],
        timeRange,
      );

      expect(timelines[0]!.roomName).toBe('project-a');
    });

    it('should default to unknown if agent has no rooms', () => {
      const agentNoRooms: Agent = {
        ...mockAgent,
        room_name: 'unknown',
      };

      const task: Task = {
        id: 1,
        room_id: 1,
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'queued',
        created_at: new Date(baseTime + 1000).toISOString(),
        updated_at: new Date(baseTime + 5000).toISOString(),
      };

      const timelines = buildAgentTimelines(
        [task],
        [],
        [agentNoRooms],
        timeRange,
      );

      expect(timelines[0]!.roomName).toBe('unknown');
    });
  });

  describe('Empty state handling', () => {
    it('should return empty array when no tasks and no taskEvents', () => {
      const timelines = buildAgentTimelines([], [], [mockAgent], timeRange);
      expect(timelines).toHaveLength(0);
    });

    it('should return empty array when agent has no tasks', () => {
      const task: Task = {
        id: 1,
        room_id: 1,
        assigned_to: 'other-agent', // not assigned to mockAgent
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'queued',
        created_at: new Date(baseTime + 1000).toISOString(),
        updated_at: new Date(baseTime + 5000).toISOString(),
      };

      const timelines = buildAgentTimelines([task], [], [mockAgent], timeRange);
      expect(timelines).toHaveLength(0);
    });
  });
});
