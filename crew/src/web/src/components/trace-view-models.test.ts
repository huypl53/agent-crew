import { describe, expect, it } from 'vitest';
import {
  buildTraceDagViewModel,
  buildTraceWaterfallViewModel,
  type TraceTimelinePayload,
} from '../types.ts';

const payload: TraceTimelinePayload = {
  spans: [
    {
      trace_id: 'crew',
      span_id: 's1',
      parent_span_id: null,
      room: 'crew',
      agent: 'a1',
      status: 'active',
      kind: 'message_turn',
      started_at: '2026-05-05T10:00:00.000Z',
      ended_at: '2026-05-05T10:00:01.000Z',
      attributes: {},
    },
    {
      trace_id: 'crew',
      span_id: 's2',
      parent_span_id: 's1',
      room: 'crew',
      agent: 'a2',
      status: 'done',
      kind: 'message_turn',
      started_at: '2026-05-05T10:00:01.000Z',
      ended_at: '2026-05-05T10:00:03.000Z',
      attributes: {},
    },
  ],
  turns: [
    {
      turn_id: 't1',
      room: 'crew',
      agent: 'a1',
      started_at: '2026-05-05T10:00:00.000Z',
      ended_at: '2026-05-05T10:00:03.000Z',
      status: 'active',
      span_ids: ['s1', 's2'],
      before_span_ids: [],
      after_span_ids: [],
      parallel_turn_ids: [],
    },
  ],
  links: [{ source_span_id: 's1', target_span_id: 's2', relation: 'reply_to' }],
};

describe('trace view models', () => {
  it('builds waterfall rows with deterministic range', () => {
    const model = buildTraceWaterfallViewModel(payload);
    expect(model.rows).toHaveLength(2);
    expect(model.min_start_ms).toBeLessThan(model.max_end_ms);
    expect(model.total_ms).toBeGreaterThan(0);
    expect(model.rows[0]?.span_id).toBe('s1');
  });

  it('builds dag from parent-child and links', () => {
    const model = buildTraceDagViewModel(payload);
    expect(model.nodes).toHaveLength(2);
    expect(model.edges.some((e) => e.id === 'parent:s1->s2')).toBe(true);
    expect(model.edges.some((e) => e.id === 'reply_to:s1->s2')).toBe(true);
  });
});
