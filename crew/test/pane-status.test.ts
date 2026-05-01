import { describe, expect, test } from 'bun:test';
import { parsePaneInputSection } from '../src/shared/pane-status.ts';

describe('parsePaneInputSection', () => {
  test('detects typing when chars between separators exceed threshold', () => {
    const pane = [
      'line above',
      '────────────────────────────',
      '❯ hello',
      '────────────────────────────',
      'status line',
    ].join('\n');

    const parsed = parsePaneInputSection(pane, 28);
    expect(parsed.typingActive).toBe(true);
    expect(parsed.inputChars).toBeGreaterThanOrEqual(5);
    expect(parsed.sanitized).toBe('line above');
  });

  test('does not detect typing when input chars are below threshold', () => {
    const pane = [
      'line above',
      '────────────────────────────',
      '❯ a',
      '────────────────────────────',
      'status line',
    ].join('\n');

    const parsed = parsePaneInputSection(pane, 28);
    expect(parsed.typingActive).toBe(false);
    expect(parsed.inputChars).toBeLessThan(4);
    expect(parsed.sanitized).toBe('line above');
  });

  test('falls back when separators are missing', () => {
    const pane = ['line a', 'line b', 'line c'].join('\n');
    const parsed = parsePaneInputSection(pane, 28);
    expect(parsed.typingActive).toBe(false);
    expect(parsed.inputChars).toBe(0);
    expect(parsed.sanitized).toBe(pane);
  });

  test('supports narrow panes with dynamic threshold', () => {
    const pane = [
      'top',
      '─────────────',
      '❯ typing',
      '─────────────',
      'footer',
    ].join('\n');

    const parsed = parsePaneInputSection(pane, 13);
    expect(parsed.typingActive).toBe(true);
    expect(parsed.sanitized).toBe('top');
  });
});
