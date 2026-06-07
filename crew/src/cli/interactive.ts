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

interface WriteStream extends Writable {
  isTTY?: boolean;
}

interface PromptOptions<T> {
  title: string;
  items: Choice<T>[];
  stdin?: Readable;
  stdout?: Writable;
}

// DRY Shared Prompt Runner
function runPrompt<T, R>({
  items,
  stdin,
  stdout,
  render,
  onKeypress,
}: {
  items: Choice<T>[];
  stdin: Readable;
  stdout: Writable;
  render: () => string;
  onKeypress: (
    key: { name: string; ctrl?: boolean },
    clear: () => void,
    render: () => void,
    cleanup: () => void,
    resolve: (val: R | null) => void,
  ) => void;
}): Promise<R | null> {
  const streamIn = stdin as ReadStream;
  const streamOut = stdout as WriteStream;
  const isTTYIn = !!streamIn.isTTY;
  const isTTYOut = !!streamOut.isTTY;

  return new Promise<R | null>((resolve) => {
    if (isTTYIn && typeof streamIn.setRawMode === 'function') {
      streamIn.setRawMode(true);
    }
    readline.emitKeypressEvents(stdin);

    if (isTTYOut) {
      stdout.write('\u001b[?25l'); // Hide cursor
    }

    const renderPrompt = () => {
      stdout.write(render());
    };

    const clearPrompt = () => {
      const lineCount = items.length + 1;
      stdout.write(`\u001b[${lineCount}A\u001b[J`);
    };

    const cleanupPrompt = () => {
      stdin.removeListener('keypress', handleKeypress);
      if (isTTYIn && typeof streamIn.setRawMode === 'function') {
        streamIn.setRawMode(false);
      }
      stdin.pause();
      if (isTTYOut) {
        stdout.write('\u001b[?25h'); // Show cursor
      }
    };

    // Safety Exit Guard
    const handleUnexpectedExit = () => {
      cleanupPrompt();
    };

    const handleUncaught = (err: Error) => {
      cleanupPrompt();
      throw err;
    };

    process.once('exit', handleUnexpectedExit);
    process.once('SIGINT', handleUnexpectedExit);
    process.once('uncaughtException', handleUncaught);

    const resolveWith = (val: R | null) => {
      process.off('exit', handleUnexpectedExit);
      process.off('SIGINT', handleUnexpectedExit);
      process.off('uncaughtException', handleUncaught);
      resolve(val);
    };

    const handleKeypress = (
      _str: unknown,
      key: { name: string; ctrl?: boolean },
    ) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        clearPrompt();
        cleanupPrompt();
        resolveWith(null);
        return;
      }
      onKeypress(key, clearPrompt, renderPrompt, cleanupPrompt, resolveWith);
    };

    stdin.on('keypress', handleKeypress);
    stdin.resume();
    renderPrompt();
  });
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

  let cursor = 0;

  return runPrompt<T, T>({
    items,
    stdin,
    stdout,
    render: () => {
      let lines = `\x1b[36m?\x1b[0m \x1b[1m${title}\x1b[22m\n`;
      for (let i = 0; i < items.length; i++) {
        const prefix = i === cursor ? '\x1b[36m❯\x1b[0m ' : '  ';
        const label =
          i === cursor ? `\x1b[36m${items[i].label}\x1b[0m` : items[i].label;
        lines += `${prefix}${label}\n`;
      }
      return lines;
    },
    onKeypress: (key, clear, render, cleanup, resolve) => {
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
    },
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

  let cursor = 0;
  const selected = new Set<number>();

  return runPrompt<T, T[]>({
    items,
    stdin,
    stdout,
    render: () => {
      let lines = `\x1b[36m?\x1b[0m \x1b[1m${title}\x1b[22m\n`;
      for (let i = 0; i < items.length; i++) {
        const checkbox = selected.has(i) ? '\x1b[32m[x]\x1b[0m' : '[ ]';
        const prefix =
          i === cursor ? `\x1b[36m❯\x1b[0m ${checkbox}` : `  ${checkbox}`;
        const label =
          i === cursor ? `\x1b[36m${items[i].label}\x1b[0m` : items[i].label;
        lines += `${prefix} ${label}\n`;
      }
      return lines;
    },
    onKeypress: (key, clear, render, cleanup, resolve) => {
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
    },
  });
}
