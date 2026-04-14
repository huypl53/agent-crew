import { describe, expect, test } from 'bun:test';
import { validateRoomName, validateCapabilities } from '../src/web/src/lib/validators.ts';
import { buildMessagePayload } from '../src/web/src/lib/compose.ts';
import type { Message } from '../src/web/src/types.ts';

const mkMsg = (id: number): Message => ({
  message_id: String(id),
  from: 'a', room: 'r', to: null, text: 'hello world',
  kind: 'chat', timestamp: '2026-01-01T00:00:00Z', sequence: id, mode: 'pull',
});

describe('validateRoomName', () => {
  test('rejects empty string', () => {
    expect(validateRoomName('')).not.toBeNull();
  });

  test('rejects whitespace-only', () => {
    expect(validateRoomName('   ')).not.toBeNull();
  });

  test('rejects names with spaces', () => {
    expect(validateRoomName('my room')).not.toBeNull();
  });

  test('rejects names over 32 chars', () => {
    expect(validateRoomName('a'.repeat(33))).not.toBeNull();
  });

  test('accepts valid name', () => {
    expect(validateRoomName('crew-agents')).toBeNull();
  });

  test('accepts underscores and digits', () => {
    expect(validateRoomName('room_1')).toBeNull();
  });

  test('accepts exactly 32 chars', () => {
    expect(validateRoomName('a'.repeat(32))).toBeNull();
  });
});

describe('validateCapabilities', () => {
  test('accepts empty string', () => {
    expect(validateCapabilities('')).toBeNull();
  });

  test('accepts whitespace-only', () => {
    expect(validateCapabilities('   ')).toBeNull();
  });

  test('accepts valid JSON array', () => {
    expect(validateCapabilities('["coding", "testing"]')).toBeNull();
  });

  test('accepts valid JSON object', () => {
    expect(validateCapabilities('{"key": "value"}')).toBeNull();
  });

  test('rejects invalid JSON', () => {
    expect(validateCapabilities('[not json')).not.toBeNull();
  });

  test('error message mentions JSON', () => {
    expect(validateCapabilities('{bad}')).toMatch(/JSON/i);
  });
});

describe('buildMessagePayload', () => {
  test('broadcast when to is empty', () => {
    const p = buildMessagePayload('crew', 'hello', '', 'chat', 'push', null);
    expect(p.to).toBeUndefined();
    expect(p.room).toBe('crew');
    expect(p.text).toBe('hello');
  });

  test('directed when to is set', () => {
    const p = buildMessagePayload('crew', 'hello', 'wk-01', 'task', 'push', null);
    expect(p.to).toBe('wk-01');
    expect(p.kind).toBe('task');
  });

  test('includes replyTo when replyTarget present', () => {
    const p = buildMessagePayload('crew', 'hi', '', 'chat', 'push', mkMsg(42));
    expect(p.replyTo).toBe(42);
  });

  test('omits replyTo when no replyTarget', () => {
    const p = buildMessagePayload('crew', 'hi', '', 'chat', 'push', null);
    expect('replyTo' in p).toBe(false);
  });

  test('trims text whitespace', () => {
    const p = buildMessagePayload('crew', '  hello  ', '', 'chat', 'push', null);
    expect(p.text).toBe('hello');
  });

  test('preserves mode', () => {
    const p = buildMessagePayload('crew', 'hi', '', 'chat', 'pull', null);
    expect(p.mode).toBe('pull');
  });
});
