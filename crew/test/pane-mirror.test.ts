import { describe, expect, test } from 'bun:test';

function trimMirrorContent(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars);
}

describe('pane mirror buffer behavior', () => {
  test('keeps full content when within bound', () => {
    const content = 'abc';
    expect(trimMirrorContent(content, 10)).toBe('abc');
  });

  test('keeps tail content when over bound', () => {
    const content = '0123456789abcdef';
    expect(trimMirrorContent(content, 6)).toBe('abcdef');
  });

  test('supports large throughput chunks with deterministic bound', () => {
    const chunk = 'x'.repeat(20000);
    const trimmed = trimMirrorContent(chunk, 3000);
    expect(trimmed.length).toBe(3000);
    expect(trimmed).toBe('x'.repeat(3000));
  });
});
