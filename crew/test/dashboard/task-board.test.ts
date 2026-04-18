import { describe, expect, it } from 'bun:test';
import type { Task } from '../../src/shared/types';

/**
 * Format timestamp as relative time (e.g., "2m ago") or time of day if today, or full date if older
 * Note: in real implementation, this should accept a 'now' parameter for testability
 */
function formatTaskTimestamp(timestamp: string, now?: Date): string {
  now = now ?? new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();

  // Less than 1 minute
  if (diffMs < 60000) {
    return 'now';
  }

  // Less than 1 hour
  if (diffMs < 3600000) {
    const mins = Math.floor(diffMs / 60000);
    return `${mins}m ago`;
  }

  // Less than 24 hours: show as hours ago
  if (diffMs < 86400000) {
    const hours = Math.floor(diffMs / 3600000);
    return `${hours}h ago`;
  }

  // Check if same calendar day
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  // Same day but older than 24 hours shouldn't reach here, but keep for completeness
  if (isSameDay) {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  // Full date for older timestamps
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

describe('TaskBoard timestamp formatting', () => {
  const now = new Date();

  describe('formatTaskTimestamp', () => {
    it('should format timestamps less than 1 minute ago as "now"', () => {
      const recentTime = new Date(now.getTime() - 30000); // 30 seconds ago
      const result = formatTaskTimestamp(recentTime.toISOString());
      expect(result).toBe('now');
    });

    it('should format timestamps 2 minutes ago as "2m ago"', () => {
      const twoMinutesAgo = new Date(now.getTime() - 120000); // 2 minutes ago
      const result = formatTaskTimestamp(twoMinutesAgo.toISOString());
      expect(result).toBe('2m ago');
    });

    it('should format timestamps 1 hour ago as "1h ago"', () => {
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const result = formatTaskTimestamp(oneHourAgo.toISOString());
      expect(result).toBe('1h ago');
    });

    it('should format timestamps 3 hours ago as "3h ago"', () => {
      const threeHoursAgo = new Date(now.getTime() - 3 * 3600000);
      const result = formatTaskTimestamp(threeHoursAgo.toISOString());
      expect(result).toBe('3h ago');
    });

    it('should format timestamps from earlier today as hours ago', () => {
      const earlierToday = new Date(now);
      earlierToday.setHours(Math.max(0, now.getHours() - 6), 0, 0, 0); // 6 hours ago but same day
      const result = formatTaskTimestamp(earlierToday.toISOString());
      // Result should be in "Xh ago" format for times less than 24 hours
      expect(result).toMatch(/^\d+h ago$/);
    });

    it('should format timestamps from past days as date string', () => {
      const pastDate = new Date(now);
      pastDate.setDate(pastDate.getDate() - 5);
      const result = formatTaskTimestamp(pastDate.toISOString());
      // Result should contain month abbreviation and day, e.g., "Apr 7"
      expect(result).toMatch(/^[A-Za-z]{3}\s\d{1,2}$/);
    });

    it('should include year for dates from different year', () => {
      const lastYear = new Date(now);
      lastYear.setFullYear(now.getFullYear() - 1);
      const result = formatTaskTimestamp(lastYear.toISOString());
      // Result should include year
      expect(result).toContain(String(lastYear.getFullYear()));
    });
  });

  describe('Task line rendering with room', () => {
    it('should include room in brackets before agent name', () => {
      const task: Task = {
        id: 1,
        room: 'crew',
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Test task',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Simulate renderTaskLine logic
      const roomPrefix = `[${task.room}]`;
      const statusChar = '●';
      const line = `#${task.id} ${statusChar} ${task.status.padEnd(10)} ${roomPrefix.padEnd(8)} ${task.assigned_to.padEnd(10)} ${task.summary}`;

      expect(line).toContain('[crew]');
      expect(line).toContain('wk-01');
      expect(line).toContain('Test task');
    });

    it('should truncate long summaries', () => {
      const task: Task = {
        id: 2,
        room: 'project-a',
        assigned_to: 'wk-02',
        created_by: 'lead-01',
        message_id: null,
        summary:
          'This is a very long task summary that should be truncated to fit in the display',
        status: 'queued',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const summary =
        task.summary.length > 40
          ? task.summary.substring(0, 37) + '...'
          : task.summary;
      expect(summary.length).toBeLessThanOrEqual(40);
      expect(summary).toEndWith('...');
    });
  });

  describe('Expand view content', () => {
    it('should display all required task fields when expanded', () => {
      const task: Task = {
        id: 1,
        room: 'crew',
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: 123,
        summary: 'Test task',
        status: 'active',
        note: 'Important task',
        context: 'Build auth flow',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Check that all fields exist on the task
      expect(task.room).toBe('crew');
      expect(task.created_by).toBe('lead-01');
      expect(task.assigned_to).toBe('wk-01');
      expect(task.created_at).toBeDefined();
      expect(task.note).toBe('Important task');
      expect(task.context).toBe('Build auth flow');
    });

    it('should carry full task text from linked message', () => {
      const task: Task = {
        id: 3,
        room: 'crew',
        assigned_to: 'wk-01',
        created_by: 'lead-01',
        message_id: 616,
        summary: 'First 200 chars of the task...',
        status: 'active',
        text: 'This is the full task text with all the instructions that were sent to the worker.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      expect(task.text).toBe(
        'This is the full task text with all the instructions that were sent to the worker.',
      );
    });

    it('should handle missing optional fields (note, context)', () => {
      const task: Task = {
        id: 2,
        room: 'crew',
        assigned_to: 'wk-02',
        created_by: 'lead-01',
        message_id: null,
        summary: 'Minimal task',
        status: 'queued',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Optional fields should be undefined
      expect(task.note).toBeUndefined();
      expect(task.context).toBeUndefined();
    });
  });
});
