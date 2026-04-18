import { describe, expect, it } from 'bun:test';
import { getPaneCwd } from '../src/tmux/index.ts';

describe('getPaneCwd', () => {
  it('returns null for invalid pane', async () => {
    const result = await getPaneCwd('%99999');
    expect(result).toBeNull();
  });

  it.skipIf(!process.env.TMUX_PANE)(
    'returns CWD for current pane',
    async () => {
      const pane = process.env.TMUX_PANE!;
      const result = await getPaneCwd(pane);
      expect(result).not.toBeNull();
      expect(result!.startsWith('/')).toBe(true);
    },
  );
});
