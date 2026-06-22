import { sendCommand, sendKeys } from '../../src/tmux/index.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
  expectTextInOrder,
  sendToPane,
  waitForPaneOutput,
} from '../helpers.ts';

interface WatchFixturePane {
  name: string;
  command?: string;
  settleMs?: number;
}

type TriggerAction =
  | { type: 'send-text'; pane: string; text: string }
  | { type: 'tmux-send-keys'; pane: string; text: string }
  | { type: 'tmux-send-command'; pane: string; text: string };

interface WatchFixture {
  name: string;
  description?: string;
  tags?: string[];
  setup: {
    panes: WatchFixturePane[];
  };
  trigger: {
    actions: TriggerAction[];
  };
  watch: {
    pane: string;
    contains?: string;
    matches?: string;
    timeoutMs?: number;
  };
  expect?: {
    timedOut?: boolean;
    settleMs?: number;
    finalCaptureContains?: string[];
    finalCaptureAbsent?: string[];
    finalCaptureOrdered?: string[];
  };
}

interface WatchFailure {
  check: string;
  expected: unknown;
  actual: unknown;
}

export interface WatchFixtureResult {
  name: string;
  passed: boolean;
  failures: WatchFailure[];
}

export async function runTmuxWatchFixture(
  fixture: WatchFixture,
): Promise<WatchFixtureResult> {
  const failures: WatchFailure[] = [];
  const validationError = validateWatchFixture(fixture);
  if (validationError) {
    return {
      name: fixture?.name ?? '(invalid tmux watch fixture)',
      passed: false,
      failures: [
        {
          check: 'fixture_validation',
          expected: 'valid tmux-watch fixture',
          actual: validationError,
        },
      ],
    };
  }

  const paneTargets = new Map<string, string>();

  try {
    for (const paneDef of fixture.setup.panes) {
      const created = await createTestSession(paneDef.name);
      paneTargets.set(paneDef.name, created.pane);
      if (paneDef.command) {
        await sendToPane(created.pane, paneDef.command);
      }
      if (paneDef.settleMs && paneDef.settleMs > 0) {
        await Bun.sleep(paneDef.settleMs);
      }
    }

    const watchTarget = paneTargets.get(fixture.watch.pane);
    if (!watchTarget) {
      failures.push({
        check: 'watch.pane',
        expected: fixture.watch.pane,
        actual: 'unresolved pane',
      });
      return { name: fixture.name, passed: false, failures };
    }

    const watchPattern = fixture.watch.contains ?? fixture.watch.matches;
    const watchRegex =
      fixture.watch.matches !== undefined
        ? new RegExp(fixture.watch.matches)
        : watchPattern ?? '';

    const watchResult = await waitForPaneOutput(
      watchTarget,
      watchRegex,
      fixture.watch.timeoutMs ?? 5000,
      async () => {
        await runActions(fixture.trigger.actions, paneTargets);
      },
    );

    const expectedTimeout = fixture.expect?.timedOut === true;
    if (expectedTimeout) {
      if (watchResult.matched) {
        failures.push({
          check: 'watch.timeout',
          expected: 'timeout',
          actual: `matched: ${watchResult.seen}`,
        });
      }
    } else if (!watchResult.matched) {
      failures.push({
        check: 'watch.match',
        expected: fixture.watch.contains ?? fixture.watch.matches,
        actual: watchResult.seen,
      });
    }

    const settleMs = fixture.expect?.settleMs ?? 150;
    if (settleMs > 0) {
      await Bun.sleep(settleMs);
    }

    const finalCapture = await captureFromPane(watchTarget);
    for (const expected of fixture.expect?.finalCaptureContains ?? []) {
      if (!finalCapture.includes(expected)) {
        failures.push({
          check: 'finalCaptureContains',
          expected,
          actual: finalCapture,
        });
      }
    }
    for (const unexpected of fixture.expect?.finalCaptureAbsent ?? []) {
      if (finalCapture.includes(unexpected)) {
        failures.push({
          check: 'finalCaptureAbsent',
          expected: `not containing ${unexpected}`,
          actual: finalCapture,
        });
      }
    }
    if (fixture.expect?.finalCaptureOrdered?.length) {
      try {
        expectTextInOrder(finalCapture, fixture.expect.finalCaptureOrdered);
      } catch (error) {
        failures.push({
          check: 'finalCaptureOrdered',
          expected: fixture.expect.finalCaptureOrdered,
          actual: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await cleanupAllTestSessions().catch(() => {});
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

export async function runTmuxWatchFixtureDir(
  dir: string,
): Promise<WatchFixtureResult[]> {
  const glob = new Bun.Glob('*.fixture.json');
  const paths: string[] = [];
  for await (const path of glob.scan(dir)) {
    paths.push(path);
  }
  paths.sort();

  const results: WatchFixtureResult[] = [];
  for (const path of paths) {
    const content = await Bun.file(`${dir}/${path}`).text();
    const fixture: WatchFixture = JSON.parse(content);
    results.push(await runTmuxWatchFixture(fixture));
  }
  return results;
}

export function printTmuxWatchResults(results: WatchFixtureResult[]): {
  passed: number;
  failed: number;
} {
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.passed) {
      console.log(`  ✓ ${result.name}`);
      passed++;
      continue;
    }

    console.log(`  ✗ ${result.name}`);
    failed++;
    for (const failure of result.failures) {
      console.log(`    ${failure.check}`);
      console.log(`      expected: ${JSON.stringify(failure.expected)}`);
      console.log(`      actual:   ${JSON.stringify(failure.actual)}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

async function runActions(
  actions: TriggerAction[],
  paneTargets: Map<string, string>,
): Promise<void> {
  for (const action of actions) {
    const target = paneTargets.get(action.pane);
    if (!target) {
      throw new Error(`Unknown pane in trigger action: ${action.pane}`);
    }

    if (action.type === 'send-text') {
      await sendToPane(target, action.text);
      continue;
    }
    if (action.type === 'tmux-send-keys') {
      const result = await sendKeys(target, action.text);
      if (!result.delivered) {
        throw new Error(result.error ?? `sendKeys failed for ${action.pane}`);
      }
      continue;
    }

    const result = await sendCommand(target, action.text);
    if (!result.delivered) {
      throw new Error(result.error ?? `sendCommand failed for ${action.pane}`);
    }
  }
}

function validateWatchFixture(fixture: WatchFixture): string | null {
  if (!fixture || typeof fixture !== 'object') {
    return 'fixture must be an object';
  }
  if (typeof fixture.name !== 'string' || fixture.name.trim() === '') {
    return 'fixture.name must be a non-empty string';
  }
  if (!fixture.setup || !Array.isArray(fixture.setup.panes) || fixture.setup.panes.length === 0) {
    return 'fixture.setup.panes must be a non-empty array';
  }
  if (!fixture.trigger || !Array.isArray(fixture.trigger.actions) || fixture.trigger.actions.length === 0) {
    return 'fixture.trigger.actions must be a non-empty array';
  }
  if (!fixture.watch || typeof fixture.watch.pane !== 'string' || fixture.watch.pane.trim() === '') {
    return 'fixture.watch.pane must be a non-empty string';
  }
  if (
    typeof fixture.watch.contains !== 'string' &&
    typeof fixture.watch.matches !== 'string'
  ) {
    return 'fixture.watch must include contains or matches';
  }
  return null;
}
