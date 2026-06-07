import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface Choice<T> {
  value: T;
  label: string;
}

interface ReadStream extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => this;
}

interface PromptOptions<T> {
  title: string;
  items: Choice<T>[];
  stdin?: Readable;
  stdout?: Writable;
}

export function selectOne<T>(options: PromptOptions<T>): Promise<T | null> {
  const {
    title,
    items,
    stdin = process.stdin,
    stdout = process.stdout,
  } = options;

  if (!items || items.length === 0) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const stream = stdin as ReadStream;
    const isTTY = !!stream.isTTY;

    if (isTTY && typeof stream.setRawMode === 'function') {
      stream.setRawMode(true);
    }
    readline.emitKeypressEvents(stdin);

    // Hide cursor
    stdout.write('\u001b[?25l');

    const render = () => {
      let lines = `\x1b[36m?\x1b[0m \x1b[1m${title}\x1b[22m\n`;
      for (let i = 0; i < items.length; i++) {
        const prefix = i === cursor ? '\x1b[36m❯\x1b[0m ' : '  ';
        const label =
          i === cursor ? `\x1b[36m${items[i].label}\x1b[0m` : items[i].label;
        lines += `${prefix}${label}\n`;
      }
      stdout.write(lines);
    };

    const clear = () => {
      const lineCount = items.length + 1;
      stdout.write(`\u001b[${lineCount}A\u001b[J`);
    };

    const cleanup = () => {
      stdin.removeListener('keypress', handleKeypress);
      if (isTTY && typeof stream.setRawMode === 'function') {
        stream.setRawMode(false);
      }
      stdin.pause();
      // Show cursor
      stdout.write('\u001b[?25h');
    };

    const handleKeypress = (
      _str: unknown,
      key: { name: string; ctrl?: boolean },
    ) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        clear();
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        clear();
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        clear();
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        clear();
        cleanup();
        resolve(items[cursor].value);
      } else if (key.name === 'escape' || key.name === 'q') {
        clear();
        cleanup();
        resolve(null);
      }
    };

    stdin.on('keypress', handleKeypress);
    stdin.resume();
    render();
  });
}

export function selectMultiple<T>(
  options: PromptOptions<T>,
): Promise<T[] | null> {
  const {
    title,
    items,
    stdin = process.stdin,
    stdout = process.stdout,
  } = options;

  if (!items || items.length === 0) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const selected = new Set<number>();
    const stream = stdin as ReadStream;
    const isTTY = !!stream.isTTY;

    if (isTTY && typeof stream.setRawMode === 'function') {
      stream.setRawMode(true);
    }
    readline.emitKeypressEvents(stdin);

    // Hide cursor
    stdout.write('\u001b[?25l');

    const render = () => {
      let lines = `\x1b[36m?\x1b[0m \x1b[1m${title}\x1b[22m\n`;
      for (let i = 0; i < items.length; i++) {
        const checkbox = selected.has(i) ? '\x1b[32m[x]\x1b[0m' : '[ ]';
        const prefix =
          i === cursor ? `\x1b[36m❯\x1b[0m ${checkbox}` : `  ${checkbox}`;
        const label =
          i === cursor ? `\x1b[36m${items[i].label}\x1b[0m` : items[i].label;
        lines += `${prefix} ${label}\n`;
      }
      stdout.write(lines);
    };

    const clear = () => {
      const lineCount = items.length + 1;
      stdout.write(`\u001b[${lineCount}A\u001b[J`);
    };

    const cleanup = () => {
      stdin.removeListener('keypress', handleKeypress);
      if (isTTY && typeof stream.setRawMode === 'function') {
        stream.setRawMode(false);
      }
      stdin.pause();
      // Show cursor
      stdout.write('\u001b[?25h');
    };

    const handleKeypress = (
      _str: unknown,
      key: { name: string; ctrl?: boolean },
    ) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        clear();
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        clear();
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        clear();
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key.name === 'space') {
        clear();
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        clear();
        cleanup();
        const results = Array.from(selected).map((idx) => items[idx].value);
        resolve(results);
      } else if (key.name === 'escape' || key.name === 'q') {
        clear();
        cleanup();
        resolve(null);
      }
    };

    stdin.on('keypress', handleKeypress);
    stdin.resume();
    render();
  });
}
