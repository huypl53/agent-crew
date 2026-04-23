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
  const { getSweepRuntimeStats, setSweepEventListener } = await import(
    './server/sweep.ts'
  );
  const port = parsed.flags.port
    ? parseInt(String(parsed.flags.port), 10)
    : undefined;
  const host =
    typeof parsed.flags.host === 'string' ? parsed.flags.host : undefined;
  const headless = Boolean(parsed.flags.headless);
  const summaryIntervalSec = parsed.flags['summary-interval']
    ? parseInt(String(parsed.flags['summary-interval']), 10)
    : undefined;

  if (summaryIntervalSec !== undefined && Number.isNaN(summaryIntervalSec)) {
    console.error('Error: --summary-interval must be a number of seconds');
    process.exit(1);
  }

  setSweepEventListener((event) => {
    if (event.type === 'state') {
      console.log(
        `state: paused=${event.paused} busy_mode=${event.busy_mode} deferred=${event.deferred} coalesced=${event.coalesced}`,
      );
      return;
    }
    if (event.type === 'flush') {
      console.log(
        `event: flush leader=${event.leader ?? '-'} source=${event.source ?? 'manual'} count=${event.flush_count ?? 0} deferred=${event.deferred} coalesced=${event.coalesced}`,
      );
      return;
    }
    console.log(
      `event: defer leader=${event.leader ?? '-'} source=${event.source ?? 'manual'} deferred=${event.deferred} coalesced=${event.coalesced}`,
    );
  });

  const server = await startServer({ port, host, headless });

  if (headless) {
    console.log('Crew headless watcher running (Ctrl-C to stop)');
  } else {
    console.log(
      `Crew dashboard listening on http://${server.hostname}:${server.port}`,
    );
    console.log(`API: http://${server.hostname}:${server.port}/api/rooms`);
    console.log(`WS:  ws://${server.hostname}:${server.port}/ws`);
  }

  const initial = getSweepRuntimeStats();
  console.log(
    `state: paused=${initial.paused} busy_mode=${initial.busy_mode} deferred=${initial.deferred_total} coalesced=${initial.coalesced_updates}`,
  );

  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  if (summaryIntervalSec && summaryIntervalSec > 0) {
    summaryTimer = setInterval(() => {
      const s = getSweepRuntimeStats();
      console.log(
        `summary: paused=${s.paused} busy_mode=${s.busy_mode} deferred=${s.deferred_total} coalesced=${s.coalesced_updates} last_flush=${s.last_flush_count}`,
      );
    }, summaryIntervalSec * 1000);
  }

  // keep alive until Ctrl-C
  process.on('SIGINT', () => {
    if (summaryTimer) clearInterval(summaryTimer);
    setSweepEventListener(null);
    server.shutdown();
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

  // Handlers return MCP-shaped results — unwrap the envelope
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
