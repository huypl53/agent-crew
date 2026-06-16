import { describe, expect, test } from 'bun:test';
import {
  buildKeystrokes,
  DEFAULT_DIALOG_KEYMAP,
  describeKeyActions,
  expandKeyActions,
  type DialogKeyMap,
} from '../src/tools/dialog-keystrokes.ts';

const keys = (
  input: Parameters<typeof buildKeystrokes>[0],
  keymap?: DialogKeyMap,
) => expandKeyActions(buildKeystrokes(input, keymap));

describe('buildKeystrokes: single-select (direct submit)', () => {
  test('first option needs no navigation', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: false,
        picks: [0],
      }),
    ).toEqual(['Enter']);
  });

  test('navigates down then submits', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: false,
        picks: [1],
      }),
    ).toEqual(['Down', 'Enter']);
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: false,
        picks: [2],
      }),
    ).toEqual(['Down', 'Down', 'Enter']);
  });

  test('defaults to first option when pick missing/invalid', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: false,
        picks: [99],
      }),
    ).toEqual(['Enter']);
  });
});

describe('buildKeystrokes: multi-select', () => {
  test('selects first and last of three', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: true,
        picks: [0, 2],
      }),
    ).toEqual(['Space', 'Down', 'Down', 'Space', 'Down', 'Enter']);
  });

  test('selects a single middle option', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: true,
        picks: [1],
      }),
    ).toEqual(['Down', 'Space', 'Down', 'Down', 'Enter']);
  });

  test('selects all options', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: true,
        picks: [0, 1, 2],
      }),
    ).toEqual(['Space', 'Down', 'Space', 'Down', 'Space', 'Down', 'Enter']);
  });
});

describe('buildKeystrokes: plan approval', () => {
  test('emits a single Enter', () => {
    expect(
      keys({
        dialogType: 'plan_approval',
        optionCount: 0,
        multiSelect: false,
        picks: [],
      }),
    ).toEqual(['Enter']);
  });
});

describe('buildKeystrokes: normalization & edge cases', () => {
  test('dedupes and sorts picks', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 3,
        multiSelect: true,
        picks: [2, 0, 0, 2],
      }),
    ).toEqual(['Space', 'Down', 'Down', 'Space', 'Down', 'Enter']);
  });

  test('filters out-of-range picks', () => {
    expect(
      keys({
        dialogType: 'ask_question',
        optionCount: 2,
        multiSelect: true,
        picks: [0, 5, -1],
      }),
    ).toEqual(['Space', 'Down', 'Down', 'Enter']);
  });

  test('returns empty when no options', () => {
    expect(
      buildKeystrokes({
        dialogType: 'ask_question',
        optionCount: 0,
        multiSelect: false,
        picks: [0],
      }),
    ).toEqual([]);
  });

  test('directSubmitSingle=false forces general path for single-select', () => {
    const keymap: DialogKeyMap = { ...DEFAULT_DIALOG_KEYMAP, directSubmitSingle: false };
    expect(
      keys(
        {
          dialogType: 'ask_question',
          optionCount: 2,
          multiSelect: false,
          picks: [0],
        },
        keymap,
      ),
    ).toEqual(['Space', 'Down', 'Down', 'Enter']);
  });
});

describe('expandKeyActions / describeKeyActions', () => {
  test('expand flattens repeats', () => {
    expect(
      expandKeyActions([
        { key: 'Down', repeat: 2 },
        { key: 'Space', repeat: 1 },
      ]),
    ).toEqual(['Down', 'Down', 'Space']);
  });

  test('describe renders compact notation', () => {
    expect(
      describeKeyActions([
        { key: 'Down', repeat: 2 },
        { key: 'Space', repeat: 1 },
        { key: 'Enter', repeat: 1 },
      ]),
    ).toBe('Down×2 Space Enter');
  });
});
