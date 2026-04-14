// TODO: replace with track A real hook
import { useMemo } from 'react';

// Local type stubs — track A will add these to types.ts; integrator will update imports.
export type TraceNodeKind = 'root' | 'room' | 'agent' | 'task' | 'message';
export type TraceNodeStatus = 'queued' | 'active' | 'done' | 'error' | 'idle' | 'busy' | 'dead' | 'note' | null;
export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  label: string;
  status: TraceNodeStatus;
  timestamp: number | null;
  durationMs: number | null;
  children: TraceNode[];
  meta: Record<string, unknown>;
}

// Stub: returns a hand-built tree so TraceView compiles + renders without track A data.
export function useTraceTree(): { root: TraceNode | null; loading: boolean; error: string | null } {
  const root = useMemo<TraceNode>(() => ({
    id: 'root',
    kind: 'root',
    label: 'Crew Session',
    status: 'active',
    timestamp: Date.now() - 120_000,
    durationMs: 120_000,
    meta: {},
    children: [
      {
        id: 'room-crew',
        kind: 'room',
        label: '#crew',
        status: 'active',
        timestamp: Date.now() - 118_000,
        durationMs: 118_000,
        meta: { members: 5 },
        children: [
          {
            id: 'agent-wk01',
            kind: 'agent',
            label: 'wk-01',
            status: 'busy',
            timestamp: Date.now() - 90_000,
            durationMs: 90_000,
            meta: { role: 'worker' },
            children: [
              {
                id: 'task-42',
                kind: 'task',
                label: 'Implement TraceView component',
                status: 'active',
                timestamp: Date.now() - 60_000,
                durationMs: 60_000,
                meta: { room: 'crew' },
                children: [
                  {
                    id: 'msg-101',
                    kind: 'message',
                    label: 'task dispatched to wk-01',
                    status: 'note',
                    timestamp: Date.now() - 60_000,
                    durationMs: null,
                    meta: { kind: 'task' },
                    children: [],
                  },
                ],
              },
            ],
          },
          {
            id: 'agent-wk02',
            kind: 'agent',
            label: 'wk-02',
            status: 'idle',
            timestamp: Date.now() - 85_000,
            durationMs: 85_000,
            meta: { role: 'worker' },
            children: [
              {
                id: 'task-43',
                kind: 'task',
                label: 'Port timeline view to web',
                status: 'done',
                timestamp: Date.now() - 85_000,
                durationMs: 78_000,
                meta: { room: 'crew' },
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: 'room-general',
        kind: 'room',
        label: '#general',
        status: 'idle',
        timestamp: Date.now() - 115_000,
        durationMs: 115_000,
        meta: { members: 2 },
        children: [],
      },
    ],
  }), []);

  return { root, loading: false, error: null };
}
