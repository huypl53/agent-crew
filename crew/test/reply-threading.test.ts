import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import { addAgent, addMessage, getRoomMessages } from '../src/state/index.ts';
import { buildMessageTree, flattenTree, hasThreading } from '../src/dashboard/hooks/useMessageTree.ts';
import type { Message } from '../src/shared/types.ts';

describe('reply threading', () => {
  describe('useMessageTree', () => {
    const mkMsg = (id: number, reply_to?: number): Message => ({
      message_id: String(id),
      from: 'a', room: 'r', to: null, text: 't',
      kind: 'chat', timestamp: '00:00:00', sequence: id, mode: 'pull',
      reply_to: reply_to ?? null,
    });

    test('flat list with no reply_to builds single-level tree', () => {
      const msgs = [mkMsg(1), mkMsg(2), mkMsg(3)];
      const roots = buildMessageTree(msgs);
      expect(roots).toHaveLength(3);
      expect(roots[0]!.children).toHaveLength(0);
    });

    test('reply_to links child to correct parent', () => {
      const msgs = [mkMsg(1), mkMsg(2, 1), mkMsg(3, 1)];
      const roots = buildMessageTree(msgs);
      expect(roots).toHaveLength(1);
      expect(roots[0]!.message.sequence).toBe(1);
      expect(roots[0]!.children).toHaveLength(2);
    });

    test('multi-level nesting', () => {
      const msgs = [mkMsg(1), mkMsg(2, 1), mkMsg(3, 2)];
      const roots = buildMessageTree(msgs);
      expect(roots).toHaveLength(1);
      expect(roots[0]!.children[0]!.children).toHaveLength(1);
      expect(roots[0]!.children[0]!.children[0]!.message.sequence).toBe(3);
    });

    test('orphan reply_to (missing parent) becomes root', () => {
      const msgs = [mkMsg(2, 99)]; // parent 99 doesn't exist
      const roots = buildMessageTree(msgs);
      expect(roots).toHaveLength(1);
    });

    test('flattenTree preserves order and assigns correct prefix', () => {
      const msgs = [mkMsg(1), mkMsg(2, 1)];
      const roots = buildMessageTree(msgs);
      const rows = flattenTree(roots, new Set());
      expect(rows).toHaveLength(2);
      expect(rows[0]!.prefix).toBe('* ');   // root
      expect(rows[1]!.prefix).toContain('└─'); // last child
    });

    test('collapsed node hides children and reports hiddenCount', () => {
      const msgs = [mkMsg(1), mkMsg(2, 1), mkMsg(3, 1)];
      const roots = buildMessageTree(msgs);
      const collapsed = new Set(['1']); // collapse root
      const rows = flattenTree(roots, collapsed);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.isCollapsed).toBe(true);
      expect(rows[0]!.hiddenCount).toBe(2);
    });

    test('hasThreading returns false when no reply_to', () => {
      expect(hasThreading([mkMsg(1), mkMsg(2)])).toBe(false);
    });

    test('hasThreading returns true when any reply_to set', () => {
      expect(hasThreading([mkMsg(1), mkMsg(2, 1)])).toBe(true);
    });
  });

  describe('addMessage with replyTo', () => {
    beforeEach(() => {
      initDb(':memory:');
      addAgent('sender', 'worker', 'r', '%1');
    });
    afterEach(() => closeDb());

    test('addMessage persists reply_to to DB', () => {
      const parent = addMessage('%1', 'sender', 'r', 'parent', 'pull', null, 'chat');
      const reply = addMessage('%1', 'sender', 'r', 'reply', 'pull', null, 'chat', parent.sequence);
      expect(reply.reply_to).toBe(parent.sequence);
    });

    test('addMessage without replyTo has null reply_to', () => {
      const msg = addMessage('%1', 'sender', 'r', 'hello', 'pull', null, 'chat');
      expect(msg.reply_to).toBeNull();
    });

    test('reply_to roundtrips through getRoomMessages', () => {
      const parent = addMessage('%1', 'sender', 'r', 'parent', 'pull', null, 'chat');
      addMessage('%1', 'sender', 'r', 'reply', 'pull', null, 'chat', parent.sequence);
      const msgs = getRoomMessages('r');
      expect(msgs[1]!.reply_to).toBe(parent.sequence);
    });
  });

  describe('CLI --reply-to flag parsing', () => {
    test('buildParams for send includes reply_to when --reply-to flag present', async () => {
      const { COMMANDS } = await import('../src/cli/router.ts');
      const sendCmd = COMMANDS['send']!;
      const params = sendCmd.buildParams({ room: 'r', text: 'hi', name: 'me', 'reply-to': '42' }, []);
      expect(params.reply_to).toBe(42);
    });

    test('buildParams for send has undefined reply_to when flag absent', async () => {
      const { COMMANDS } = await import('../src/cli/router.ts');
      const sendCmd = COMMANDS['send']!;
      const params = sendCmd.buildParams({ room: 'r', text: 'hi', name: 'me' }, []);
      expect(params.reply_to).toBeUndefined();
    });
  });
});
