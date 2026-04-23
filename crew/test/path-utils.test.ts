import { describe, expect, it } from 'bun:test';
import { normalizePath } from '../src/shared/path-utils.ts';

describe('normalizePath', () => {
  it('strips trailing slashes', () => {
    expect(normalizePath('/Users/lee/code/')).toBe('/Users/lee/code');
  });

  it('resolves relative paths', () => {
    const result = normalizePath('.');
    expect(result.startsWith('/')).toBe(true);
    expect(result.endsWith('.')).toBe(false);
  });

  it('handles paths without trailing slash', () => {
    expect(normalizePath('/Users/lee/code')).toBe('/Users/lee/code');
  });
});
