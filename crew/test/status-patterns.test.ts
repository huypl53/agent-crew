import { describe, expect, test } from 'bun:test';
import { matchStatusLine, IDLE_PATTERN, BUSY_PATTERN, COMPLETE_PATTERN } from '../src/shared/status-patterns.ts';

describe('status patterns', () => {
  describe('IDLE_PATTERN', () => {
    test('matches empty prompt', () => {
      expect(IDLE_PATTERN.test('❯ ')).toBe(true);
      expect(IDLE_PATTERN.test('❯')).toBe(true);
    });
    test('does not match prompt with content', () => {
      expect(IDLE_PATTERN.test('❯ some command')).toBe(false);
    });
  });

  describe('BUSY_PATTERN', () => {
    test('matches spinner patterns', () => {
      expect(BUSY_PATTERN.test('· Contemplating… (3s)')).toBe(true);
      expect(BUSY_PATTERN.test('* Wandering… (1s)')).toBe(true);
      expect(BUSY_PATTERN.test('✶ Gitifying… (8s · ↑ 84 tokens)')).toBe(true);
      expect(BUSY_PATTERN.test('✽ Gitifying… (1m 13s · ↓ 433 tokens)')).toBe(true);
    });
    test('does not match random text', () => {
      expect(BUSY_PATTERN.test('hello world')).toBe(false);
    });
  });

  describe('COMPLETE_PATTERN', () => {
    test('matches complete indicators', () => {
      expect(COMPLETE_PATTERN.test('✻ Baked for 1m 2s')).toBe(true);
      expect(COMPLETE_PATTERN.test('✻ Cooked for 54s')).toBe(true);
    });
  });

  describe('matchStatusLine', () => {
    test('returns idle for empty prompt', () => {
      expect(matchStatusLine('some output\n❯ ')).toBe('idle');
    });
    test('returns busy for spinner', () => {
      expect(matchStatusLine('some output\n· Contemplating… (3s)')).toBe('busy');
    });
    test('returns idle for complete', () => {
      expect(matchStatusLine('✻ Baked for 1m 2s\n❯ ')).toBe('idle');
    });
    test('returns unknown for no match', () => {
      expect(matchStatusLine('random text')).toBe('unknown');
    });
    test('busy takes priority over idle', () => {
      expect(matchStatusLine('❯ \n· Contemplating… (3s)')).toBe('busy');
    });
  });
});
