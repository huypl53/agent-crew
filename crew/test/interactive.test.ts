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
});
