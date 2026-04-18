import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import {
  buildMessageTree,
  flattenTree,
  hasThreading,
} from '../src/web/src/hooks/useMessageTree.ts';
import type { Message } from '../src/web/src/types.ts';

const mkMsg = (id: number, reply_to?: number): Message => ({
  message_id: String(id),
  from: 'a',
  room: 'r',
  to: null,
  text: 'hi',
  kind: 'chat',
  timestamp: '2026-01-01T00:00:00Z',
  sequence: id,
  mode: 'pull',
  reply_to: reply_to ?? null,
});

describe('web build', () => {
  test('bun run build:web produces crew/dist/web/index.html', () => {
    // Build was run during setup — verify artifact exists
    expect(
      existsSync(new URL('../dist/web/index.html', import.meta.url).pathname),
    ).toBe(true);
  });
});

describe('web useMessageTree (no Ink deps)', () => {
  test('hasThreading — false when no reply_to', () => {
    expect(hasThreading([mkMsg(1), mkMsg(2)])).toBe(false);
  });

  test('hasThreading — true when reply_to present', () => {
    expect(hasThreading([mkMsg(1), mkMsg(2, 1)])).toBe(true);
  });

  test('buildMessageTree — flat list becomes single-level roots', () => {
    const roots = buildMessageTree([mkMsg(1), mkMsg(2), mkMsg(3)]);
    expect(roots).toHaveLength(3);
    roots.forEach((r) => expect(r.children).toHaveLength(0));
  });

  test('buildMessageTree — reply_to links child to parent', () => {
    const roots = buildMessageTree([mkMsg(1), mkMsg(2, 1), mkMsg(3, 1)]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children).toHaveLength(2);
  });

  test('buildMessageTree — multi-level nesting', () => {
    const roots = buildMessageTree([mkMsg(1), mkMsg(2, 1), mkMsg(3, 2)]);
    expect(roots[0]!.children[0]!.children[0]!.message.sequence).toBe(3);
  });

  test('buildMessageTree — orphan reply_to becomes root', () => {
    expect(buildMessageTree([mkMsg(5, 99)])).toHaveLength(1);
  });

  test('flattenTree — collapsed node hides children', () => {
    const roots = buildMessageTree([mkMsg(1), mkMsg(2, 1), mkMsg(3, 1)]);
    const rows = flattenTree(roots, new Set(['1']));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hiddenCount).toBe(2);
  });

  test('flattenTree — last child gets └─ prefix', () => {
    const roots = buildMessageTree([mkMsg(1), mkMsg(2, 1)]);
    const rows = flattenTree(roots, new Set());
    expect(rows[1]!.prefix).toContain('└─');
  });

  test('flattenTree — non-last child gets ├─ prefix', () => {
    const roots = buildMessageTree([mkMsg(1), mkMsg(2, 1), mkMsg(3, 1)]);
    const rows = flattenTree(roots, new Set());
    expect(rows[1]!.prefix).toContain('├─');
    expect(rows[2]!.prefix).toContain('└─');
  });
});
