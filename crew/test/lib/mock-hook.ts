/**
 * Mock Hook — simulate Claude Code hook triggers without a real instance.
 * Calls processHookEventInput directly with the same JSON contract.
 */

import { processHookEventInput } from '../../src/tools/hook-event.ts';
import type { ToolResult } from '../../src/shared/types.ts';

export interface HookEventPayload {
  hook_event_name?: string;
  event?: string;
  session_id?: string;
  sessionId?: string;
  permission_suggestions?: Array<{
    type: string;
    mode?: string;
    destination?: string;
  }>;
  [key: string]: unknown;
}

export interface HookResult {
  raw: ToolResult;
  json: Record<string, unknown>;
  ok: boolean;
  decision?: string;
  hint?: { agent_name: string; message: string };
  hookSpecificOutput?: Record<string, unknown>;
}

export interface SequenceStep {
  event: string;
  payload?: Partial<HookEventPayload>;
  delay?: number;
}

export class MockHook {
  readonly pane: string | undefined;
  readonly defaultSessionId: string;
  readonly results: HookResult[] = [];

  constructor(opts: { pane?: string; sessionId?: string }) {
    this.pane = opts.pane;
    this.defaultSessionId = opts.sessionId ?? `mock-session-${Date.now()}`;
  }

  async fire(
    event: string,
    extra?: Partial<HookEventPayload>,
  ): Promise<HookResult> {
    const base: HookEventPayload = {
      session_id: this.defaultSessionId,
      ...extra,
    };
    if (event !== '__skip__') {
      base.hook_event_name = event;
    }
    const payload = base;

    const input = JSON.stringify(payload);
    const raw = await processHookEventInput(input, this.pane);
    const result = this.parseResult(raw);
    this.results.push(result);
    return result;
  }

  async sequence(steps: SequenceStep[]): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const step of steps) {
      if (step.delay && step.delay > 0) {
        await new Promise((r) => setTimeout(r, step.delay));
      }
      const result = await this.fire(step.event, step.payload);
      results.push(result);
    }
    return results;
  }

  async concurrent(
    events: Array<{ event: string; payload?: Partial<HookEventPayload> }>,
  ): Promise<HookResult[]> {
    return Promise.all(events.map((e) => this.fire(e.event, e.payload)));
  }

  async fireMalformed(input: string): Promise<HookResult> {
    const raw = await processHookEventInput(input, this.pane);
    const result = this.parseResult(raw);
    this.results.push(result);
    return result;
  }

  reset(): void {
    this.results.length = 0;
  }

  private parseResult(raw: ToolResult): HookResult {
    const text =
      raw.content
        ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('') ?? '';

    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text };
    }

    return {
      raw,
      json,
      ok: json.ok === true,
      decision: json.decision as string | undefined,
      hint: json.hint as { agent_name: string; message: string } | undefined,
      hookSpecificOutput: json.hookSpecificOutput as Record<string, unknown> | undefined,
    };
  }
}
