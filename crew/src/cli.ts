#!/usr/bin/env bun
import { formatError, formatHelp, formatResult } from './cli/formatter.ts';
import { parseArgs } from './cli/parse.ts';
import { COMMANDS } from './cli/router.ts';
import { initServerLog } from './shared/server-log.ts';
import { initDb } from './state/db.ts';

initServerLog();

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);

if (parsed.command === 'help' || parsed.flags.help) {
  console.log(formatHelp());
  process.exit(0);
}

// 'wait-idle' polls tmux directly — no DB needed
if (parsed.command === 'wait-idle') {
  const { handleWaitIdle } = await import('./tools/wait-idle.ts');
  await handleWaitIdle({
    target: String(parsed.flags.target ?? parsed.positional[0] ?? ''),
    stable_count: parsed.flags['stable-count']
      ? parseInt(String(parsed.flags['stable-count']), 10)
      : undefined,
    idle_seconds: parsed.flags['idle-seconds']
      ? parseInt(String(parsed.flags['idle-seconds']), 10)
      : undefined,
    poll_interval: parsed.flags['poll-interval']
      ? parseInt(String(parsed.flags['poll-interval']), 10)
      : undefined,
    timeout: parsed.flags.timeout
      ? parseInt(String(parsed.flags.timeout), 10)
      : undefined,
    lines: parsed.flags.lines
      ? parseInt(String(parsed.flags.lines), 10)
      : undefined,
  });
  process.exit(0);
}

// 'serve' is handled before initDb() since startServer() calls initDb() itself
if (parsed.command === 'serve') {
  const { startServer } = await import('./server/index.ts');
  const port = parsed.flags.port
    ? parseInt(String(parsed.flags.port), 10)
    : undefined;
  const host =
    typeof parsed.flags.host === 'string' ? parsed.flags.host : undefined;
  const server = startServer({ port, host });
  console.log(
    `Crew dashboard listening on http://${server.hostname}:${server.port}`,
  );
  console.log(`API: http://${server.hostname}:${server.port}/api/rooms`);
  console.log(`WS:  ws://${server.hostname}:${server.port}/ws`);
  // keep alive until Ctrl-C
  process.on('SIGINT', () => {
    server.stop(true);
    process.exit(0);
  });
  await new Promise(() => {}); // block forever
}

initDb();

const cmd = COMMANDS[parsed.command];
if (!cmd) {
  console.error(
    `Unknown command: ${parsed.command}. Run 'crew help' for usage.`,
  );
  process.exit(1);
}

try {
  const params = cmd.buildParams(parsed.flags, parsed.positional);
  const result = await cmd.handler(params);

  // MCP tool results have content[0].text with JSON
  const data = JSON.parse(result.content[0].text);

  if (result.isError) {
    console.error(formatError(data));
    process.exit(1);
  }

  if (parsed.flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatResult(parsed.command, data));
  }
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
