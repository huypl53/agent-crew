/**
 * Fixture Runner — deterministic replay harness for hook payloads.
 *
 * These fixtures drive `processHookEventInput()` through MockHook, seed DB
 * state, and assert on hook JSON output plus mocked tmux side effects.
 * They do NOT watch live tmux panes or verify real delivery stability.
 * Adding a new replay edge case = adding a JSON file.
 */

import { mock } from 'bun:test';
import { resolve } from 'node:path';
import {
  armLeaderGoalReminder,
  completeGoal,
  setGoal,
} from '../../src/state/goal-state.ts';
import {
  addAgent,
  closeDb,
  getLatestHookEvent,
  getOrCreateRoom,
  getRecentHookEvents,
  initDb,
  setHint,
} from '../../src/state/index.ts';
import { MockHook } from './mock-hook.ts';
import type { TapEntry } from './tmux-tap.ts';

type AgentRole = 'leader' | 'worker';

export const _tapLog: TapEntry[] = [];

const tmuxModulePath = resolve(import.meta.dir, '../../src/tmux/index.ts');

mock.module(tmuxModulePath, () => ({
  sendKeys: async (target: string, text: string) => {
    _tapLog.push({
      ts: Date.now(),
      op: 'sendKeys',
      target,
      args: [text],
      result: { delivered: true },
    });
    return { delivered: true };
  },
  sendCommand: async (target: string, text: string) => {
    _tapLog.push({
      ts: Date.now(),
      op: 'sendCommand',
      target,
      args: [text],
      result: { delivered: true },
    });
    return { delivered: true };
  },
  paneExists: async () => true,
  isPaneDead: async () => false,
  paneCommandLooksAlive: async () => true,
  capturePane: async () => '',
  capturePaneTail: async () => '',
  capturePaneWithAnsi: async () => '',
  getPaneCwd: () => null,
  getPaneCurrentCommand: async () => 'node',
  getPaneSessionName: async () => null,
  validateTmux: async () => ({ ok: true, version: 'mock' }),
  createSession: async () => '%0',
  splitPane: async () => '%1',
  killPane: async () => true,
  killSession: async () => true,
  sendEscape: async () => ({ delivered: true }),
  sendSigint: async () => ({ delivered: true }),
  sendClear: async () => ({ delivered: true }),
  sendKey: async () => ({ delivered: true }),
  sendKeyHex: async () => ({ delivered: true }),
  listSessionWindows: async () => [],
  getActiveWindowIndex: async () => null,
  splitPaneInWindow: async () => '%2',
}));

export interface FixtureSeed {
  room: { name: string; path: string };
  agents: Array<{
    name: string;
    pane: string;
    role: 'leader' | 'worker';
    cwd?: string;
  }>;
  hints?: Array<{ agent: string; message: string; cadence?: number }>;
  goals?: Array<{
    agent: string;
    description: string;
    status?: 'active' | 'done';
    armed?: boolean;
  }>;
}

export interface FixtureExpect {
  stdout?: Record<string, unknown>;
  stdout_path?: Array<{ path: string; value: unknown }>;
  tmux?: Array<{
    op: string;
    target?: string;
    contains?: string;
    matches?: string;
  }>;
  tmux_absent?: Array<{ op: string; target?: string; contains?: string }>;
  hook_event?: {
    agent: string;
    event?: string;
    session_id?: string | null;
    payload_contains?: string;
    absent?: boolean;
  };
  hook_events_count?: number;
}

export interface FixtureStep {
  event: string;
  pane?: string | null;
  payload?: Record<string, unknown>;
  delay?: number;
  expect?: FixtureExpect;
}

export interface Fixture {
  name: string;
  description?: string;
  tags?: string[];
  seed: FixtureSeed;
  steps: FixtureStep[];
}

export interface FixtureFailure {
  step: number;
  check: string;
  expected: unknown;
  actual: unknown;
}

export interface FixtureResult {
  name: string;
  passed: boolean;
  failures: FixtureFailure[];
}

export async function runFixture(fixture: Fixture): Promise<FixtureResult> {
  const failures: FixtureFailure[] = [];
  const defaultSessionIds = new Map<string, string>();
  _tapLog.length = 0;

  const validationError = validateFixture(fixture);
  if (validationError) {
    return {
      name: fixture?.name ?? '(invalid fixture)',
      passed: false,
      failures: [
        {
          step: -1,
          check: 'fixture_validation',
          expected: 'valid deterministic replay fixture',
          actual: validationError,
        },
      ],
    };
  }

  try {
    initDb(':memory:');
    const room = getOrCreateRoom(
      fixture.seed.room.path,
      fixture.seed.room.name,
    );

    for (const ag of fixture.seed.agents) {
      addAgent(ag.name, ag.role as AgentRole, room.id, ag.pane);
    }

    if (fixture.seed.hints) {
      for (const h of fixture.seed.hints) {
        setHint(h.agent, room.id, h.message, { cadence: h.cadence ?? 3 });
      }
    }

    if (fixture.seed.goals) {
      for (const g of fixture.seed.goals) {
        setGoal(g.agent, room.id, g.description);
        if (g.armed) {
          armLeaderGoalReminder(g.agent, room.id);
        }
        if (g.status === 'done') {
          completeGoal(g.agent, room.id);
        }
      }
    }

    for (let i = 0; i < fixture.steps.length; i++) {
      const step = fixture.steps[i];
      if (!step) continue;
      const defaultPane = fixture.seed.agents[0]?.pane ?? '%0';
      const pane = Object.hasOwn(step, 'pane')
        ? (step.pane ?? undefined)
        : defaultPane;
      const sessionKey = pane ?? '__no_pane__';
      const defaultSessionId =
        defaultSessionIds.get(sessionKey) ??
        `fixture-session-${fixture.name}-${sessionKey}`;
      defaultSessionIds.set(sessionKey, defaultSessionId);
      const hook = new MockHook({ pane, sessionId: defaultSessionId });

      if (step.delay && step.delay > 0) {
        await new Promise((r) => setTimeout(r, step.delay));
      }

      const preStepLogLen = _tapLog.length;

      const rawInput = step.payload?.__raw_input__;
      const result =
        typeof rawInput === 'string'
          ? await hook.fireMalformed(rawInput)
          : await hook.fire(step.event, step.payload);

      // Goal reminders use setTimeout(1500ms) — wait long when actual event is Stop
      const effectiveEvent =
        step.event === '__skip__'
          ? String(step.payload?.event ?? step.payload?.eventName ?? '')
          : step.event;
      const waitMs = effectiveEvent === 'Stop' ? 2000 : 50;
      await new Promise((r) => setTimeout(r, waitMs));

      if (!step.expect) continue;

      const stepLog = _tapLog.slice(preStepLogLen);

      if (step.expect.stdout) {
        for (const [key, expected] of Object.entries(step.expect.stdout)) {
          const actual = result.json[key];
          if (!deepEqual(actual, expected)) {
            failures.push({
              step: i,
              check: `stdout.${key}`,
              expected,
              actual,
            });
          }
        }
      }

      if (step.expect.stdout_path) {
        for (const { path, value } of step.expect.stdout_path) {
          const actual = getByPath(result.json, path);
          if (!deepEqual(actual, value)) {
            failures.push({
              step: i,
              check: `stdout_path:${path}`,
              expected: value,
              actual,
            });
          }
        }
      }

      if (step.expect.tmux) {
        for (const check of step.expect.tmux) {
          const matching = findTmuxEntries(stepLog, check);
          if (matching.length === 0) {
            failures.push({
              step: i,
              check: `tmux:${check.op}${check.target ? `→${check.target}` : ''}`,
              expected: check.contains ?? check.matches ?? '(any)',
              actual: stepLog
                .filter((e) => e.op === check.op)
                .map(summarizeEntry),
            });
          }
        }
      }

      if (step.expect.tmux_absent) {
        for (const check of step.expect.tmux_absent) {
          const matching = findTmuxEntries(stepLog, check);
          if (matching.length > 0) {
            failures.push({
              step: i,
              check: `tmux_absent:${check.op}${check.target ? `→${check.target}` : ''}`,
              expected: 'no match',
              actual: matching.map(summarizeEntry),
            });
          }
        }
      }

      if (typeof step.expect.hook_events_count === 'number') {
        const actual = getRecentHookEvents(0, 1000).length;
        if (actual !== step.expect.hook_events_count) {
          failures.push({
            step: i,
            check: 'hook_events_count',
            expected: step.expect.hook_events_count,
            actual,
          });
        }
      }

      if (step.expect.hook_event) {
        const check = step.expect.hook_event;
        const latest = getLatestHookEvent(
          check.agent,
          check.event,
          check.session_id === undefined
            ? undefined
            : (check.session_id ?? undefined),
        );
        if (check.absent) {
          if (latest) {
            failures.push({
              step: i,
              check: `hook_event_absent:${check.agent}`,
              expected: null,
              actual: {
                event_type: latest.event_type,
                session_id: latest.session_id,
                payload: latest.payload,
              },
            });
          }
        } else if (!latest) {
          failures.push({
            step: i,
            check: `hook_event:${check.agent}`,
            expected: {
              event: check.event ?? '(latest)',
              session_id: check.session_id ?? '(any)',
            },
            actual: null,
          });
        } else if (
          check.payload_contains &&
          !(latest.payload ?? '').includes(check.payload_contains)
        ) {
          failures.push({
            step: i,
            check: `hook_event_payload:${check.agent}`,
            expected: check.payload_contains,
            actual: latest.payload,
          });
        }
      }
    }
  } finally {
    _tapLog.length = 0;
    try {
      closeDb();
    } catch {
      /* already closed */
    }
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

export async function runFixtureDir(dir: string): Promise<FixtureResult[]> {
  const glob = new Bun.Glob('*.fixture.json');
  const paths: string[] = [];
  for await (const path of glob.scan(dir)) {
    paths.push(path);
  }
  paths.sort();

  const results: FixtureResult[] = [];
  for (const path of paths) {
    const content = await Bun.file(`${dir}/${path}`).text();
    const fixture: Fixture = JSON.parse(content);
    results.push(await runFixture(fixture));
  }
  return results;
}

export function printResults(results: FixtureResult[]): {
  passed: number;
  failed: number;
} {
  let passed = 0,
    failed = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${r.name}`);
      failed++;
      for (const f of r.failures) {
        console.log(`    step ${f.step}: ${f.check}`);
        console.log(`      expected: ${JSON.stringify(f.expected)}`);
        console.log(`      actual:   ${JSON.stringify(f.actual)}`);
      }
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

function findTmuxEntries(
  log: TapEntry[],
  check: { op: string; target?: string; contains?: string; matches?: string },
): TapEntry[] {
  return log.filter((e) => {
    if (e.op !== check.op) return false;
    if (check.target && e.target !== check.target) return false;
    const text = Array.isArray(e.args) ? String(e.args[0]) : '';
    if (check.contains && !text.includes(check.contains)) return false;
    if (check.matches && !new RegExp(check.matches).test(text)) return false;
    return true;
  });
}

function validateFixture(fixture: Fixture): string | null {
  if (!fixture || typeof fixture !== 'object') {
    return 'fixture must be an object';
  }
  if (typeof fixture.name !== 'string' || fixture.name.trim() === '') {
    return 'fixture.name must be a non-empty string';
  }
  if (!fixture.seed || typeof fixture.seed !== 'object') {
    return 'fixture.seed must be present';
  }
  if (!fixture.seed.room || typeof fixture.seed.room !== 'object') {
    return 'fixture.seed.room must be present';
  }
  if (!Array.isArray(fixture.seed.agents) || fixture.seed.agents.length === 0) {
    return 'fixture.seed.agents must be a non-empty array';
  }
  if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) {
    return 'fixture.steps must be a non-empty array';
  }
  for (let i = 0; i < fixture.steps.length; i++) {
    const step = fixture.steps[i];
    if (!step || typeof step.event !== 'string' || step.event.trim() === '') {
      return `fixture.steps[${i}].event must be a non-empty string`;
    }
  }
  return null;
}

function summarizeEntry(e: TapEntry): string {
  const text = Array.isArray(e.args) ? String(e.args[0]).slice(0, 60) : '';
  return `${e.op}(${e.target ?? '?'}, "${text}...")`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined))
    return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keysA = Object.keys(aObj);
  const keysB = Object.keys(bObj);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(aObj[k], bObj[k]));
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
