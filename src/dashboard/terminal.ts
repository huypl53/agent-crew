export const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  inverse: '\x1b[7m',
} as const;

export interface TerminalSize {
  cols: number;
  rows: number;
}

type InputHandler = (key: string, raw: Buffer) => void;
type ResizeHandler = (size: TerminalSize) => void;

let cleanedUp = false;

export function getTerminalSize(): TerminalSize {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

export function enterAlternateScreen(): void {
  process.stdout.write('\x1b[?1049h');
  process.stdout.write('\x1b[?25l');
}

export function exitAlternateScreen(): void {
  process.stdout.write('\x1b[?25h');
  process.stdout.write('\x1b[?1049l');
}

export function enableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
}

export function disableRawMode(): void {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export function writeFrame(buffer: string): void {
  process.stdout.write(buffer);
}

export function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  exitAlternateScreen();
  disableRawMode();
}

export function registerCleanup(): void {
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGHUP', () => { cleanup(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    cleanup();
    console.error('Unhandled rejection:', err);
    process.exit(1);
  });
}

export function onInput(handler: InputHandler): void {
  process.stdin.on('data', (data: Buffer) => {
    const hex = data.toString('hex');
    if (hex === '1b5b41') return handler('up', data);
    if (hex === '1b5b42') return handler('down', data);
    if (hex === '1b5b43') return handler('right', data);
    if (hex === '1b5b44') return handler('left', data);
    if (data[0] === 0x6a) return handler('down', data);  // j
    if (data[0] === 0x6b) return handler('up', data);    // k
    if (hex === '6767') return handler('home', data);     // gg
    if (data[0] === 0x47) return handler('end', data);    // G
    if (data[0] === 0x3f) return handler('help', data);   // ?
    if (data[0] === 0x09) return handler('tab', data);    // Tab
    if (data[0] === 0x2f) return handler('search', data); // /
    if (data[0] === 0x71) return handler('q', data);
    if (data[0] === 0x03) return handler('ctrl-c', data);
    if (data[0] === 0x0d) return handler('enter', data);
    if (data[0] === 0x20) return handler('space', data);
    handler('other', data);
  });
}

export function onResize(handler: ResizeHandler): void {
  process.stdout.on('resize', () => {
    handler(getTerminalSize());
  });
}

export function initTerminal(): TerminalSize {
  registerCleanup();
  enterAlternateScreen();
  enableRawMode();
  return getTerminalSize();
}
