import { describe, expect, test } from 'bun:test';
import {
  CC_BUSY_PATTERN,
  CC_COMPLETE_PATTERN,
  CC_IDLE_PATTERN,
  matchStatusLine,
} from '../src/shared/status-patterns.ts';

describe('status patterns', () => {
  describe('CC_IDLE_PATTERN', () => {
    test('matches empty prompt', () => {
      expect(CC_IDLE_PATTERN.test('❯ ')).toBe(true);
      expect(CC_IDLE_PATTERN.test('❯')).toBe(true);
    });
    test('does not match prompt with content', () => {
      expect(CC_IDLE_PATTERN.test('❯ some command')).toBe(false);
    });
  });

  describe('CC_BUSY_PATTERN', () => {
    test('matches spinner patterns', () => {
      expect(CC_BUSY_PATTERN.test('· Contemplating… (3s)')).toBe(true);
      expect(CC_BUSY_PATTERN.test('* Wandering… (1s)')).toBe(true);
      expect(CC_BUSY_PATTERN.test('✶ Gitifying… (8s · ↑ 84 tokens)')).toBe(
        true,
      );
      expect(CC_BUSY_PATTERN.test('✽ Gitifying… (1m 13s · ↓ 433 tokens)')).toBe(
        true,
      );
      expect(
        CC_BUSY_PATTERN.test(
          '✳ Adding re-sync types… (7m 35s · ↑ 7.9k tokens)',
        ),
      ).toBe(true);
    });
    test('does not match random text', () => {
      expect(CC_BUSY_PATTERN.test('hello world')).toBe(false);
    });
  });

  describe('CC_COMPLETE_PATTERN', () => {
    test('matches complete indicators', () => {
      expect(CC_COMPLETE_PATTERN.test('✻ Baked for 1m 2s')).toBe(true);
      expect(CC_COMPLETE_PATTERN.test('✻ Cooked for 54s')).toBe(true);
    });
  });

  describe('matchStatusLine', () => {
    test('returns idle for empty prompt', () => {
      expect(matchStatusLine('some output\n❯ ')).toBe('idle');
    });
    test('returns busy for spinner', () => {
      expect(matchStatusLine('some output\n· Contemplating… (3s)')).toBe(
        'busy',
      );
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
