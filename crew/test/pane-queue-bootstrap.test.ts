import { describe, expect, setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(10000);

describe('PaneQueue bootstrap delivery', () => {
  test('does not block first delivery on typingActive when no hook history exists', async () => {
    const paneQueueUrl = new URL(
      '../src/delivery/pane-queue.ts',
      import.meta.url,
    ).href;
    const paneStatusUrl = new URL(
      '../src/shared/pane-status.ts',
      import.meta.url,
    ).href;
    const stateIndexUrl = new URL('../src/state/index.ts', import.meta.url)
      .href;
    const tmuxUrl = new URL('../src/tmux/index.ts', import.meta.url).href;
    const script = `
      import { mock } from 'bun:test';

      mock.module(${JSON.stringify(paneStatusUrl)}, () => ({
        getPaneStatus: async () => ({
          status: 'unknown',
          contentChanged: false,
          typingActive: true,
          inputChars: 24,
        }),
      }));

      mock.module(${JSON.stringify(stateIndexUrl)}, () => ({
        getAgentByPane: () => ({ name: 'worker-1', role: 'worker', input_block_mode: 'off' }),
        getLatestHookEvent: () => null,
      }));

      let sendKeysCalls = 0;
      mock.module(${JSON.stringify(tmuxUrl)}, () => ({
        paneExists: async () => true,
        sendKeys: async () => {
          sendKeysCalls += 1;
          return { delivered: true };
        },
        sendCommand: async () => ({ delivered: true }),
        sendEscape: async () => ({ delivered: true }),
        sendSigint: async () => ({ delivered: true }),
        sendClear: async () => ({ delivered: true }),
        sendKey: async () => ({ delivered: true }),
        sendKeyHex: async () => ({ delivered: true }),
      }));

      const { PaneQueue } = await import(${JSON.stringify(paneQueueUrl)});
      const q = new PaneQueue('%1', { role: 'worker' });
      const startedAt = performance.now();
      await q.enqueue({ type: 'paste', text: 'bootstrap-assignment' });
      const elapsed = performance.now() - startedAt;

      if (sendKeysCalls !== 1) {
        console.error('sendKeysCalls=' + sendKeysCalls);
        process.exit(2);
      }
      if (elapsed >= 2000) {
        console.error('elapsed=' + elapsed);
        process.exit(3);
      }
    `;

    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();

    if (exitCode !== 0) {
      throw new Error(
        `bootstrap subprocess failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  });
});
