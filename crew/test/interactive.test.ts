import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { selectMultiple, selectOne } from '../src/cli/interactive.ts';

class MockStdin extends Readable {
  _read() {}
  sendKey(key: { name: string; ctrl?: boolean }) {
    this.emit('keypress', null, key);
  }
}

class MockStdout extends Writable {
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

    // Check if clear sequence is sent to stdout on Ctrl+C.
    // Line count for 2 items is 3, so clear code is '\u001b[3A\u001b[J'
    const clears = stdout.output.filter((o) => o.includes('\u001b[3A\u001b[J'));
    expect(clears.length).toBeGreaterThan(0);
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
