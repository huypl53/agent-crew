import { existsSync, readFileSync } from 'node:fs';
import { assertAgentCanInspectWorker } from '../shared/role-guard.ts';
import { getAllAgents, getLatestHookEvent } from '../state/index.ts';
import { capturePane } from '../tmux/index.ts';
import { resolveAgentSession } from '../tokens/pid-mapper.ts';
import {
  extractHookCompletionMessage,
  resolveAgentRuntime,
} from '../shared/hook-runtime.ts';
import {
  extractRecentClaudeTurns,
  type InspectionTurn,
} from './claude-transcript.ts';
import type {
  BlockHint,
  DegradationReason,
  InspectionSnapshot,
  InspectWorkerParams,
} from './types.ts';

interface ResolvedSession {
  sessionId: string;
  sessionPath: string;
}

interface InspectWorkerDeps {
  sessionResolver?: (tmuxTarget: string) => Promise<ResolvedSession | null>;
  transcriptLoader?: (sessionPath: string) => Promise<string | null>;
  paneLoader?: (tmuxTarget: string) => Promise<string | null>;
}

function isCompletionHookEvent(
  eventType: string | null | undefined,
): boolean {
  return eventType === 'Stop' || eventType === 'StopFailure';
}

function deriveHookStatus(
  latestEvent: { event_type?: string | null } | null,
): 'idle' | 'busy' | 'unknown' {
  if (!latestEvent) return 'unknown';
  return isCompletionHookEvent(latestEvent.event_type) ? 'idle' : 'busy';
}

function detectBlockHint(
  status: InspectionSnapshot['status'],
  turns: InspectionTurn[],
): BlockHint {
  if (status === 'idle') return 'idle';
  const latestAssistant = [...turns]
    .reverse()
    .find((turn) => turn.role === 'assistant')
    ?.text.toLowerCase();
  if (!latestAssistant) return status === 'busy' ? 'running' : 'unknown';
  if (
    latestAssistant.includes('permission') ||
    latestAssistant.includes('approval')
  ) {
    return 'waiting_for_permission';
  }
  if (
    latestAssistant.includes('?') ||
    latestAssistant.includes('confirm') ||
    latestAssistant.includes('which should')
  ) {
    return 'waiting_for_user_input';
  }
  return status === 'busy' ? 'running' : 'unknown';
}

async function buildHookFallback(
  workerName: string,
  roomName: string,
  agentType: 'claude-code' | 'codex' | 'unknown',
  sessionId: string | null,
  degradationReason: DegradationReason,
): Promise<InspectionSnapshot> {
  const scopedSessionId = sessionId ?? undefined;
  const latestEvent = getLatestHookEvent(
    workerName,
    undefined,
    scopedSessionId,
  );
  const latestStop = getLatestHookEvent(workerName, 'Stop', scopedSessionId);
  const latestStopFailure = getLatestHookEvent(
    workerName,
    'StopFailure',
    scopedSessionId,
  );
  const latestCompletionEvent =
    latestStop && latestStopFailure
      ? latestStop.id > latestStopFailure.id
        ? latestStop
        : latestStopFailure
      : latestStop ?? latestStopFailure;
  const latestRelevantEvent =
    latestCompletionEvent &&
    (!latestEvent || latestCompletionEvent.id >= latestEvent.id)
      ? latestCompletionEvent
      : latestEvent;
  const assistantText = extractHookCompletionMessage(
    latestRelevantEvent?.payload ?? null,
  );
  const turns = assistantText
    ? [
      {
        role: 'assistant' as const,
        text: assistantText,
        timestamp: latestRelevantEvent?.created_at ?? null,
      },
    ]
    : [];
  const status =
    deriveHookStatus(latestEvent);

  return {
    agent_name: workerName,
    room_name: roomName,
    provider: agentType,
    session_id: sessionId,
    status,
    updated_at: latestRelevantEvent?.created_at ?? null,
    block_hint: detectBlockHint(status, turns),
    source: 'hook-events',
    turns,
    degraded: true,
    degradation_reason: degradationReason,
  };
}

export async function inspectWorkerTurns(
  params: InspectWorkerParams,
  deps: InspectWorkerDeps = {},
): Promise<InspectionSnapshot> {
  const { worker } = assertAgentCanInspectWorker(
    params.workerName,
    params.roomName,
    params.callerName,
  );

  const limit = params.turns && params.turns > 0 ? params.turns : 2;
  const resolvedAgentType = await resolveAgentRuntime(
    worker.agent_type,
    worker.tmux_target,
  );

  const sessionResolver =
    deps.sessionResolver ??
    (async (tmuxTarget: string) => {
      const session = await resolveAgentSession(tmuxTarget);
      if (!session) return null;
      return {
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
      };
    });
  const transcriptLoader =
    deps.transcriptLoader ??
    (async (sessionPath: string) => {
      if (!existsSync(sessionPath)) return null;
      return readFileSync(sessionPath, 'utf-8');
    });
  const paneLoader = deps.paneLoader ?? capturePane;

  const resolvedSession = worker.tmux_target
    ? await sessionResolver(worker.tmux_target)
    : null;
  if (resolvedSession) {
    const transcript = await transcriptLoader(resolvedSession.sessionPath);
    if (transcript) {
      const turns = extractRecentClaudeTurns(transcript, limit);
      if (turns.length > 0) {
        const updatedAt = turns[turns.length - 1]?.timestamp ?? null;
        const latestEvent = getLatestHookEvent(
          worker.name,
          undefined,
          resolvedSession.sessionId,
        );
        const status = deriveHookStatus(latestEvent);
        return {
          agent_name: worker.name,
          room_name: worker.room_name,
          provider: resolvedAgentType,
          session_id: resolvedSession.sessionId,
          status,
          updated_at: updatedAt,
          block_hint: detectBlockHint(status, turns),
          source: 'transcript',
          turns,
          degraded: false,
          degradation_reason: 'none',
        };
      }
      return await buildHookFallback(
        worker.name,
        worker.room_name,
        resolvedAgentType,
        resolvedSession.sessionId,
        'transcript_unavailable',
      );
    }
    return await buildHookFallback(
      worker.name,
      worker.room_name,
      resolvedAgentType,
      resolvedSession.sessionId,
      'transcript_unavailable',
    );
  }

  const latestEvent = getLatestHookEvent(worker.name);
  const sameNameWorkers = getAllAgents().filter(
    (agent) => agent.name === worker.name && agent.role === 'worker',
  );
  if (sameNameWorkers.length > 1) {
    throw new Error(
      `Unable to resolve session for worker "${worker.name}". Use a unique worker name per room or restore session resolution.`,
    );
  }
  const hookSnapshot = await buildHookFallback(
    worker.name,
    worker.room_name,
    resolvedAgentType,
    latestEvent?.session_id ?? null,
    'session_unresolved',
  );
  if (hookSnapshot.turns.length > 0 || !worker.tmux_target) {
    return hookSnapshot;
  }

  const paneText = await paneLoader(worker.tmux_target);
  const trimmed = paneText?.trim();
  if (trimmed) {
    const status = deriveHookStatus(latestEvent);
    const turns = [
      { role: 'assistant' as const, text: trimmed, timestamp: null },
    ];
    return {
      agent_name: worker.name,
      room_name: worker.room_name,
      provider: resolvedAgentType,
      session_id: latestEvent?.session_id ?? null,
      status,
      updated_at: null,
      block_hint: detectBlockHint(status, turns),
      source: 'tmux-fallback',
      turns,
      degraded: true,
      degradation_reason: 'tmux_only',
    };
  }

  return hookSnapshot;
}
