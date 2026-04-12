#!/usr/bin/env bun
import { parseArgs } from './cli/parse.ts';
import { COMMANDS } from './cli/router.ts';
import { formatResult, formatError, formatHelp } from './cli/formatter.ts';
import { initDb } from './state/db.ts';
import { initServerLog } from './shared/server-log.ts';

initServerLog();
initDb();

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);

if (parsed.command === 'help' || parsed.flags.help) {
  console.log(formatHelp());
  process.exit(0);
}

const cmd = COMMANDS[parsed.command];
if (!cmd) {
  console.error(`Unknown command: ${parsed.command}. Run 'crew help' for usage.`);
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
