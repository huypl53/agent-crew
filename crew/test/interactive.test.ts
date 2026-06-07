import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { selectMultiple, selectOne } from '../src/cli/interactive.ts';

class MockStdin extends Readable {
  isTTY = true;
  rawModeEnabled = false;
  _read() {}
  setRawMode(mode: boolean) {
    this.rawModeEnabled = mode;
    return this;
  }
  sendKey(key: { name: string; ctrl?: boolean }) {
    this.emit('keypress', null, key);
  }
}

class MockStdout extends Writable {
  isTTY = true;
  output: string[] = [];
  _write(
    chunk: string | Buffer | Uint8Array,
    _encoding: string,
    callback: () => void,
  ) {
    this.output.push(chunk.toString());
    callback();
  }
}

describe('TUI Interactive Prompts', () => {
  test('selectOne resolves with highlighted item on Enter', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    const items = [
      { value: 'opt1', label: 'Option 1' },
      { value: 'opt2', label: 'Option 2' },
    ];

    const promise = selectOne({
      title: 'Select one',
      items,
      stdin,
      stdout,
    });

    stdin.sendKey({ name: 'down' });
    stdin.sendKey({ name: 'return' });

    const result = await promise;
    expect(result).toBe('opt2');
    expect(stdin.rawModeEnabled).toBe(false);
  });

  test('selectOne supports j and k navigation', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    const items = [
      { value: 'opt1', label: 'Option 1' },
      { value: 'opt2', label: 'Option 2' },
    ];

    const promise = selectOne({
      title: 'Select one',
      items,
      stdin,
      stdout,
    });

    stdin.sendKey({ name: 'j' });
    stdin.sendKey({ name: 'k' });
    stdin.sendKey({ name: 'j' });
    stdin.sendKey({ name: 'return' });

    const result = await promise;
    expect(result).toBe('opt2');
  });

  test('selectOne handles wrap-around index navigation', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    const items = [
      { value: 'opt1', label: 'Option 1' },
      { value: 'opt2', label: 'Option 2' },
    ];

    const promise = selectOne({
      title: 'Select one',
      items,
      stdin,
      stdout,
    });

    stdin.sendKey({ name: 'up' });
    stdin.sendKey({ name: 'down' });
    stdin.sendKey({ name: 'down' });
    stdin.sendKey({ name: 'return' });

    const result = await promise;
    expect(result).toBe('opt2');
  });

  test('selectOne resolves with null on escape or q', async () => {
    const stdin1 = new MockStdin();
    const stdout1 = new MockStdout();
    const items = [
      { value: 'opt1', label: 'Option 1' },
      { value: 'opt2', label: 'Option 2' },
    ];

    const promise1 = selectOne({
      title: 'Select one',
      items,
      stdin: stdin1,
      stdout: stdout1,
    });
    stdin1.sendKey({ name: 'escape' });
    const result1 = await promise1;
    expect(result1).toBeNull();

    const stdin2 = new MockStdin();
    const stdout2 = new MockStdout();
    const promise2 = selectOne({
      title: 'Select one',
      items,
      stdin: stdin2,
      stdout: stdout2,
    });
    stdin2.sendKey({ name: 'q' });
    const result2 = await promise2;
    expect(result2).toBeNull();
  });

  test('selectMultiple toggles selection with Space and resolves on Enter', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    const items = [
      { value: 'opt1', label: 'Option 1' },
      { value: 'opt2', label: 'Option 2' },
    ];

    const promise = selectMultiple({
      title: 'Select multiple',
      items,
      stdin,
      stdout,
    });

    stdin.sendKey({ name: 'space' });
    stdin.sendKey({ name: 'down' });
    stdin.sendKey({ name: 'space' });
    stdin.sendKey({ name: 'return' });

    const result = await promise;
    expect(result).toEqual(['opt1', 'opt2']);
  });

  test('selectOne clears stdout and resolves with null on Ctrl+C', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    const items = [
      { value: 'opt1', label: 'Option 1' },
      { value: 'opt2', label: 'Option 2' },
    ];

    const promise = selectOne({
      title: 'Select one',
      items,
      stdin,
      stdout,
    });

    stdin.sendKey({ name: 'c', ctrl: true });

    const result = await promise;
    expect(result).toBeNull();

    const clears = stdout.output.filter((o) => o.includes('\u001b[3A\u001b[J'));
    expect(clears.length).toBeGreaterThan(0);
  });

  test('does not write cursor control sequences if stdout is not a TTY', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    stdout.isTTY = false;

    const items = [{ value: 'opt1', label: 'Option 1' }];

    const promise = selectOne({
      title: 'Select one',
      items,
      stdin,
      stdout,
    });

    stdin.sendKey({ name: 'return' });
    await promise;

    const hasCursorHide = stdout.output.some((o) => o.includes('\u001b[?25l'));
    const hasCursorShow = stdout.output.some((o) => o.includes('\u001b[?25h'));
    const hasLineClear = stdout.output.some((o) =>
      o.includes('\u001b[2A\u001b[J'),
    );
    expect(hasCursorHide).toBe(false);
    expect(hasCursorShow).toBe(false);
    expect(hasLineClear).toBe(false);
  });

  test('selectOne and selectMultiple resolve with null immediately if items is empty', async () => {
    const stdin = new MockStdin();
    const stdout = new MockStdout();

    const resultOne = await selectOne({
      title: 'Select one',
      items: [],
      stdin,
      stdout,
    });
    expect(resultOne).toBeNull();

    const resultMultiple = await selectMultiple({
      title: 'Select multiple',
      items: [],
      stdin,
      stdout,
    });
    expect(resultMultiple).toBeNull();
  });
});
