import { describe, expect, test } from 'bun:test';

async function runSweepProbe(statusLiteral: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const sweepUrl = new URL('../src/server/sweep.ts', import.meta.url).href;
  const paneStatusUrl = new URL('../src/shared/pane-status.ts', import.meta.url)
    .href;
  const paneQueueUrl = new URL('../src/delivery/pane-queue.ts', import.meta.url)
    .href;
  const tmuxUrl = new URL('../src/tmux/index.ts', import.meta.url).href;
  const stateDbUrl = new URL('../src/state/db.ts', import.meta.url).href;
  const stateIndexUrl = new URL('../src/state/index.ts', import.meta.url).href;

  const script = `
    import { mock } from 'bun:test';

    let enqueueCalls = 0;
    mock.module(${JSON.stringify(paneStatusUrl)}, () => ({
      getPaneStatus: async () => (${statusLiteral}),
    }));

    mock.module(${JSON.stringify(paneQueueUrl)}, () => ({
      PaneDeliveryError: class PaneDeliveryError extends Error {
        constructor(message, code) {
          super(message);
          this.code = code;
        }
      },
      getQueue: () => ({
        enqueue: async () => {
          enqueueCalls += 1;
        },
      }),
      removeQueue: () => {},
    }));

    mock.module(${JSON.stringify(tmuxUrl)}, () => ({
      paneCommandLooksAlive: async () => true,
      isPaneDead: async () => false,
      paneExists: async () => true,
      capturePane: async () => '',
      capturePaneTail: async () => '',
      capturePaneWithAnsi: async () => '',
      getPaneCwd: async () => null,
      getPaneCurrentCommand: async () => 'node',
      getPaneSessionName: async () => null,
      sendKeys: async () => ({ delivered: true }),
      sendCommand: async () => ({ delivered: true }),
      sendEscape: async () => ({ delivered: true }),
      sendSigint: async () => ({ delivered: true }),
      sendClear: async () => ({ delivered: true }),
      sendKey: async () => ({ delivered: true }),
      sendKeyHex: async () => ({ delivered: true }),
    }));

    const { initDb, closeDb, getDb } = await import(${JSON.stringify(stateDbUrl)});
    const { addAgent, addHookEvent, getOrCreateRoom } = await import(${JSON.stringify(
      stateIndexUrl,
    )});
    const {
      getSweepRuntimeStats,
      resetSweepRuntimeState,
      runSweepOnce,
    } = await import(${JSON.stringify(sweepUrl)});

    initDb(':memory:');
    resetSweepRuntimeState();

    const room = getOrCreateRoom('/test/sweep-observation', 'sweep-observation');
    addAgent('lead-1', 'leader', room.id, '%10', 'unknown');
    addAgent('worker-1', 'worker', room.id, '%11', 'unknown');
    addHookEvent('worker-1', 'Stop', 'sess-1', '{}', room.id);

    const staleTs = new Date(Date.now() - 61_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    getDb().run('UPDATE hook_events SET created_at = ? WHERE agent_name = ?', [
      staleTs,
      'worker-1',
    ]);

    await runSweepOnce();
    const stats = getSweepRuntimeStats();
    console.log(JSON.stringify({ enqueueCalls, deferred: stats.deferred_total }));
    closeDb();
  `;

  const proc = Bun.spawn(['bun', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('sweep observation policy', () => {
  test('typing-only observation does not defer leader delivery', async () => {
    const result = await runSweepProbe(`{
      status: 'unknown',
      contentChanged: false,
      typingActive: true,
      inputChars: 24,
    }`);

    if (result.exitCode !== 0) {
      throw new Error(
        `probe failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    const data = JSON.parse(result.stdout.trim());
    expect(data.enqueueCalls).toBeGreaterThan(0);
    expect(data.deferred).toBe(0);
  });

  test('hook-backed busy status still defers leader delivery', async () => {
    const result = await runSweepProbe(`{
      status: 'busy',
      contentChanged: false,
      typingActive: false,
      inputChars: 0,
    }`);

    if (result.exitCode !== 0) {
      throw new Error(
        `probe failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    const data = JSON.parse(result.stdout.trim());
    expect(data.deferred).toBeGreaterThan(0);
  });
});
