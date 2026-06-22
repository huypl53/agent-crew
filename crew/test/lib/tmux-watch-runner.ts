import { closeDb, initDb } from '../../src/state/db.ts';
import { processHookEventInput } from '../../src/tools/hook-event.ts';
import { handleInputBlock } from '../../src/tools/input-block.ts';
import { handleJoinRoom } from '../../src/tools/join-room.ts';
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
  | { type: 'tmux-send-command'; pane: string; text: string }
  | {
      type: 'crew-join-room';
      pane: string;
      role: string;
      room: string;
      name?: string;
    }
  | {
      type: 'crew-input-block';
      name: string;
      subcommand?: string;
      persist?: boolean;
    }
  | {
      type: 'crew-hook-event';
      pane?: string;
      payload?: Record<string, unknown>;
      rawInput?: string;
    }
  | { type: 'capture-pane'; pane: string };

interface ActionResultExpectation {
  index: number;
  path: string;
  equals?: unknown;
  min?: number;
  contains?: string;
  absent?: string;
}

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
    actionResults?: ActionResultExpectation[];
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
    initDb(':memory:');

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

    const watchTarget = resolvePaneTarget(paneTargets, fixture.watch.pane);
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

    let actionResults: unknown[] = [];
    let actionsPromise: Promise<unknown[]> | null = null;
    const watchResult = await waitForPaneOutput(
      watchTarget,
      watchRegex,
      fixture.watch.timeoutMs ?? 5000,
      async () => {
        actionsPromise = runActions(fixture.trigger.actions, paneTargets);
        actionResults = await actionsPromise;
      },
    );
    if (actionsPromise) {
      actionResults = await actionsPromise;
    }

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

    for (const check of fixture.expect?.actionResults ?? []) {
      const actual = getByPath(actionResults[check.index], check.path);
      if (check.equals !== undefined && !deepEqual(actual, check.equals)) {
        failures.push({
          check: `actionResults[${check.index}].${check.path}`,
          expected: check.equals,
          actual,
        });
      }
      if (check.min !== undefined) {
        if (typeof actual !== 'number' || actual < check.min) {
          failures.push({
            check: `actionResults[${check.index}].${check.path}`,
            expected: `>= ${check.min}`,
            actual,
          });
        }
      }
      if (check.contains !== undefined) {
        if (typeof actual !== 'string' || !actual.includes(check.contains)) {
          failures.push({
            check: `actionResults[${check.index}].${check.path}`,
            expected: `contains ${check.contains}`,
            actual,
          });
        }
      }
      if (check.absent !== undefined) {
        if (typeof actual === 'string' && actual.includes(check.absent)) {
          failures.push({
            check: `actionResults[${check.index}].${check.path}`,
            expected: `not containing ${check.absent}`,
            actual,
          });
        }
      }
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
    try {
      closeDb();
    } catch {
      // Already closed.
    }
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
): Promise<unknown[]> {
  const results: unknown[] = [];

  for (const action of actions) {
    if (action.type === 'crew-input-block') {
      results.push(await parseToolResult(handleInputBlock(action)));
      continue;
    }

    const paneRef = 'pane' in action && action.pane ? action.pane : undefined;
    const target = paneRef ? resolvePaneTarget(paneTargets, paneRef) : undefined;
    if (paneRef && !target) {
      throw new Error(`Unknown pane in trigger action: ${paneRef}`);
    }

    if (action.type === 'send-text') {
      await sendToPane(target!, action.text);
      results.push({ delivered: true, type: action.type, pane: target });
      continue;
    }
    if (action.type === 'tmux-send-keys') {
      const result = await sendKeys(target!, action.text);
      if (!result.delivered) {
        throw new Error(result.error ?? `sendKeys failed for ${action.pane}`);
      }
      results.push(result);
      continue;
    }
    if (action.type === 'tmux-send-command') {
      const result = await sendCommand(target!, action.text);
      if (!result.delivered) {
        throw new Error(result.error ?? `sendCommand failed for ${action.pane}`);
      }
      results.push(result);
      continue;
    }
    if (action.type === 'crew-join-room') {
      results.push(
        await parseToolResult(
          handleJoinRoom({
            room: action.room,
            role: action.role,
            name: action.name,
            tmux_target: target,
          }),
        ),
      );
      continue;
    }
    if (action.type === 'crew-hook-event') {
      const input = action.rawInput ?? JSON.stringify(action.payload ?? {});
      results.push(await parseToolResult(processHookEventInput(input, target)));
      continue;
    }
    if (action.type === 'capture-pane') {
      results.push({ pane: target, capture: await captureFromPane(target!) });
      continue;
    }

    throw new Error(`Unsupported trigger action: ${(action as { type: string }).type}`);
  }

  return results;
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

function resolvePaneTarget(
  paneTargets: Map<string, string>,
  paneRef: string,
): string | undefined {
  return paneTargets.get(paneRef) ?? (paneRef.startsWith('%') ? paneRef : undefined);
}

async function parseToolResult(
  resultPromise: Promise<{ content: Array<{ text: string }>; isError?: boolean }>,
): Promise<unknown> {
  const result = await resultPromise;
  const text = result.content[0]?.text ?? '{}';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (result.isError === true) {
    throw new Error(
      typeof parsed.error === 'string' ? parsed.error : `crew action failed: ${text}`,
    );
  }
  if (typeof parsed.error === 'string' && parsed.error.length > 0) {
    throw new Error(parsed.error);
  }
  return parsed;
}

function getByPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!segment) return current;
    if (current && typeof current === 'object' && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
