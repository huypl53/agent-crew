import { randomUUID } from 'node:crypto';
import { deliverMessage } from '../delivery/index.ts';
import type {
  MessageBatchWorkerDispatchStatus,
  MessageDeliveryMetadata,
  SendBatchManifest,
  ToolResult,
} from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { resolveAgentRuntime } from '../shared/hook-runtime.ts';
import {
  createMessageBatch,
  getRoomMembers,
  markBatchWorkerDispatchFailed,
  markBatchWorkerSent,
} from '../state/index.ts';
import { paneCommandLooksAlive, paneExists } from '../tmux/index.ts';
import { readUtf8TextFile, validateSenderAndRoom } from './send-message.ts';

interface SendBatchParams {
  room: string;
  manifest: string;
  name: string;
}

interface NormalizedManifestWorker {
  name: string;
  file: string;
}

type NormalizedSendBatchManifest = SendBatchManifest & {
  workers: NormalizedManifestWorker[];
};

interface SendBatchWorkerResult {
  name: string;
  dispatch_status: MessageBatchWorkerDispatchStatus;
}

function generateBatchId(): string {
  return `batch_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function parseManifest(rawText: string): {
  value?: NormalizedSendBatchManifest;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { error: 'Manifest is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Manifest must be a JSON object' };
  }

  const data = parsed as Record<string, unknown>;

  let leader: string | undefined;
  if (data.leader !== undefined) {
    if (typeof data.leader !== 'string' || !data.leader.trim()) {
      return { error: 'Manifest leader must be a non-empty string' };
    }
    leader = data.leader.trim();
  }

  if (!Array.isArray(data.workers) || data.workers.length === 0) {
    return { error: 'Manifest must include at least one worker' };
  }

  const workers: NormalizedManifestWorker[] = [];
  const names = new Set<string>();
  for (let i = 0; i < data.workers.length; i++) {
    const worker = data.workers[i] as Record<string, unknown> | undefined;
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)) {
      return { error: `Manifest worker at index ${i} must be an object` };
    }

    if (typeof worker.name !== 'string' || !worker.name.trim()) {
      return {
        error: `Manifest worker at index ${i} must include a non-empty name`,
      };
    }
    if (typeof worker.file !== 'string' || !worker.file.trim()) {
      return {
        error: `Manifest worker "${worker.name}" must include a non-empty file path`,
      };
    }

    const name = worker.name.trim();
    const file = worker.file.trim();
    if (names.has(name)) {
      return { error: 'Manifest worker names must be unique' };
    }
    names.add(name);
    workers.push({ name, file });
  }

  if (
    data.hintAfterSeconds !== undefined &&
    (!Number.isInteger(data.hintAfterSeconds) || data.hintAfterSeconds <= 0)
  ) {
    return { error: 'hintAfterSeconds must be a positive integer' };
  }

  return {
    value: {
      leader,
      workers,
      hintAfterSeconds: data.hintAfterSeconds as number | undefined,
    },
  };
}

async function loadManifest(
  manifestPath: string,
): Promise<{ value?: NormalizedSendBatchManifest; error?: string }> {
  const manifestFile = await readUtf8TextFile(manifestPath, 'Manifest');
  if (manifestFile.error) {
    return { error: manifestFile.error };
  }
  return parseManifest(manifestFile.text!);
}

function validateWorkerMembership(
  roomName: string,
  roomId: number,
  manifest: NormalizedSendBatchManifest,
): { error?: string } {
  const membersByName = new Map(
    getRoomMembers(roomId).map((member) => [member.name, member]),
  );

  for (const worker of manifest.workers) {
    const member = membersByName.get(worker.name);
    if (!member) {
      return {
        error: `Worker "${worker.name}" is not a member of room "${roomName}"`,
      };
    }
    if (member.role !== 'worker') {
      return {
        error: `Worker "${worker.name}" is not a worker in room "${roomName}"`,
      };
    }
  }

  return {};
}

async function preflightWorkerDelivery(
  roomName: string,
  roomId: number,
  manifest: NormalizedSendBatchManifest,
): Promise<{ error?: string }> {
  const membersByName = new Map(
    getRoomMembers(roomId).map((member) => [member.name, member]),
  );

  for (const worker of manifest.workers) {
    const member = membersByName.get(worker.name);
    if (!member?.tmux_target) {
      return {
        error: `Worker "${worker.name}" has no active tmux pane in room "${roomName}"`,
      };
    }

    if (!(await paneExists(member.tmux_target))) {
      return {
        error: `Worker "${worker.name}" pane ${member.tmux_target} no longer exists`,
      };
    }

    const agentRuntime = await resolveAgentRuntime(
      member.agent_type,
      member.tmux_target,
    );
    if (agentRuntime === 'claude-code' || agentRuntime === 'codex') {
      if (!(await paneCommandLooksAlive(member.tmux_target))) {
        return {
          error: `stale-target: pane ${member.tmux_target} is not running an agent process`,
        };
      }
    }
  }

  return {};
}

export async function handleSendBatch(
  params: SendBatchParams,
): Promise<ToolResult> {
  const { room, manifest, name } = params;

  if (!room || !manifest || !name) {
    return err('Missing required params: room, manifest, name');
  }

  const senderContext = validateSenderAndRoom(room, name);
  if (senderContext.error) {
    return err(senderContext.error);
  }

  const { sender, room: roomObj } = senderContext.value!;
  if (sender.role !== 'leader') {
    return err('Batch dispatch requires a leader sender');
  }

  const manifestResult = await loadManifest(manifest);
  if (manifestResult.error) {
    return err(manifestResult.error);
  }
  const parsedManifest = manifestResult.value!;

  if (parsedManifest.leader && parsedManifest.leader !== name) {
    return err(
      `Manifest leader "${parsedManifest.leader}" does not match sender "${name}"`,
    );
  }

  const workerMembership = validateWorkerMembership(
    room,
    roomObj.id,
    parsedManifest,
  );
  if (workerMembership.error) {
    return err(workerMembership.error);
  }

  const loadedWorkers: Array<{
    name: string;
    file: string;
    text: string;
    resolvedPath: string;
  }> = [];

  for (const worker of parsedManifest.workers) {
    const promptFile = await readUtf8TextFile(worker.file, 'Worker prompt');
    if (promptFile.error) {
      return err(promptFile.error);
    }
    loadedWorkers.push({
      name: worker.name,
      file: worker.file,
      text: promptFile.text!,
      resolvedPath: promptFile.resolvedPath!,
    });
  }

  const preflight = await preflightWorkerDelivery(
    room,
    roomObj.id,
    parsedManifest,
  );
  if (preflight.error) {
    return err(preflight.error);
  }

  const batchId = generateBatchId();
  try {
    createMessageBatch({
      batchId,
      roomId: roomObj.id,
      leaderName: name,
      hintAfterSeconds: parsedManifest.hintAfterSeconds ?? null,
      workers: loadedWorkers.map((worker) => ({
        workerName: worker.name,
        promptFile: worker.resolvedPath,
      })),
    });
  } catch (error) {
    return err(
      error instanceof Error ? error.message : 'Failed to create batch state',
    );
  }

  const workers: SendBatchWorkerResult[] = [];
  for (let i = 0; i < loadedWorkers.length; i++) {
    const worker = loadedWorkers[i]!;
    const metadata: MessageDeliveryMetadata = {
      batch_id: batchId,
      worker_name: worker.name,
      prompt_file: worker.resolvedPath,
      manifest_order: i,
    };

    try {
      const results = await deliverMessage(
        name,
        room,
        worker.text,
        worker.name,
        undefined,
        metadata,
      );
      const result = results[0];
      if (result && !result.error) {
        try {
          markBatchWorkerSent(batchId, worker.name);
          workers.push({ name: worker.name, dispatch_status: 'sent' });
        } catch (error) {
          markBatchWorkerDispatchFailed(
            batchId,
            worker.name,
            error instanceof Error ? error.message : String(error),
          );
          workers.push({ name: worker.name, dispatch_status: 'failed' });
        }
      } else {
        const errorText = result?.error ?? 'Dispatch failed';
        markBatchWorkerDispatchFailed(batchId, worker.name, errorText);
        workers.push({ name: worker.name, dispatch_status: 'failed' });
      }
    } catch (error) {
      markBatchWorkerDispatchFailed(
        batchId,
        worker.name,
        error instanceof Error ? error.message : String(error),
      );
      workers.push({ name: worker.name, dispatch_status: 'failed' });
    }
  }

  return ok({
    batch_id: batchId,
    workers,
  });
}
