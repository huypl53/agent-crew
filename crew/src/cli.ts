#!/usr/bin/env bun
import { basename } from 'node:path';
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

// 'wait-idle' uses hook events (lazy DB init) with tmux fallback
if (parsed.command === 'wait-idle') {
  const { handleWaitIdle } = await import('./tools/wait-idle.ts');
  await handleWaitIdle({
    target: String(parsed.flags.target ?? parsed.positional[0] ?? ''),
    poll_interval: parsed.flags['poll-interval']
      ? parseInt(String(parsed.flags['poll-interval']), 10)
      : undefined,
    timeout: parsed.flags.timeout
      ? parseInt(String(parsed.flags.timeout), 10)
      : undefined,
  });
  process.exit(0);
}

initDb();

// Auto-detect caller name if --name is not explicitly provided
if (!parsed.flags.name && parsed.command !== 'manage') {
  const envName = process.env.CREW_AGENT_NAME?.trim();
  if (envName) {
    parsed.flags.name = envName;
  } else {
    const pane = process.env.TMUX_PANE;
    if (pane) {
      try {
        const { getAgentByPane } = await import('./state/index.ts');
        const paneAgent = getAgentByPane(pane);
        if (paneAgent) {
          parsed.flags.name = paneAgent.name;
        }
      } catch (_e) {
        // ignore state import error
      }
    }
  }
}

const cmd = COMMANDS[parsed.command];
if (!cmd) {
  console.error(
    `Unknown command: ${parsed.command}. Run 'crew help' for usage.`,
  );
  process.exit(1);
}

// Default room to current directory basename if not provided and no positional args are present.
// Skip for hint commands — they auto-detect room from TMUX_PANE.
if (
  !parsed.flags.room &&
  !parsed.flags['room-id'] &&
  parsed.command !== 'hint' &&
  parsed.positional.length === 0
) {
  parsed.flags.room = basename(process.cwd());
}

try {
  const params = cmd.buildParams(parsed.flags, parsed.positional);
  const result = await cmd.handler(params);

  // Handlers return MCP-shaped results — unwrap the envelope
  const data = JSON.parse(result.content[0].text);

  if (result.isError) {
    console.error(formatError(data));
    process.exit(1);
  }

  // PermissionRequest hooks require the special hookSpecificOutput envelope.
  // Output it as raw JSON and skip normal formatting.
  if (data.hookSpecificOutput) {
    console.log(JSON.stringify({ hookSpecificOutput: data.hookSpecificOutput }));
  } else if (parsed.flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const out = formatResult(parsed.command, data);
    if (out !== '') console.log(out);
  }

  // hook-event user-visible output: write the status dashboard to stderr
  // and exit 1 so Claude Code shows it as a non-blocking notice.
  // stdout (model context) is still emitted normally via formatResult.
  const hookNotices =
    parsed.command === 'hook-event' && typeof data.statusDashboard === 'string'
      ? [data.statusDashboard]
      : [];
  if (hookNotices.length > 0) {
    for (const notice of hookNotices) {
      process.stderr.write(`${notice}\n`);
    }
  }

  // Exit 1 when hook notices were emitted to stderr — Claude Code shows
  // stderr from non-zero exits as a non-blocking notice visible to the user.
  if (hookNotices.length > 0) {
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
