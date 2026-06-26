export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'version',
  'confirm',
  'dev',
  'persist',
  'self',
  'inline',
]);

/** Short flag aliases: -c → cadence, etc. */
const SHORT_FLAGS: Record<string, string> = {
  c: 'cadence',
  n: 'name',
  p: 'persist',
};

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { command: 'help', positional: [], flags: {} };

  const command = argv[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }

    const nextArg = argv[i + 1];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        i++;
      } else if (nextArg && !nextArg.startsWith('-')) {
        flags[key] = nextArg;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
      continue;
    }

    const shortKey =
      arg.startsWith('-') && arg.length === 2
        ? SHORT_FLAGS[arg[1] ?? '']
        : undefined;
    if (shortKey) {
      if (BOOLEAN_FLAGS.has(shortKey)) {
        flags[shortKey] = true;
        i++;
      } else if (nextArg && !nextArg.startsWith('-')) {
        flags[shortKey] = nextArg;
        i += 2;
      } else {
        flags[shortKey] = true;
        i++;
      }
      continue;
    }

    positional.push(arg);
    i++;
  }

  return { command, positional, flags };
}
