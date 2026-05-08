import { waitForIdle } from '../utils/wait-for-idle.ts';

interface WaitIdleParams {
  target: string;
  poll_interval?: number;
  timeout?: number;
}

/**
 * CLI handler for `crew wait-idle`.
 * Does NOT return a ToolResult — outputs directly and exits.
 * Called inline from cli.ts before initDb().
 */
export async function handleWaitIdle(params: WaitIdleParams): Promise<void> {
  const { target, poll_interval, timeout } = params;

  if (!target) {
    console.error('Error: --target <pane> is required');
    process.exit(1);
  }

  const result = await waitForIdle({
    target,
    pollInterval: poll_interval,
    timeout,
  });

  if (result.timedOut) {
    console.error(
      `wait-idle: timed out after ${result.elapsed}ms (pane ${target} never settled)`,
    );
    process.exit(2);
  }

  console.log(`idle pane=${target} elapsed=${result.elapsed}ms`);
}
