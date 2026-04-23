import type { SweepBusyMode, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import {
  getSweepControlState,
  setSweepBusyMode,
  setSweepPaused,
} from '../state/index.ts';

interface PausePollingParams {
  reason?: string;
}

interface SetPollingBusyParams {
  mode?: SweepBusyMode | string;
}

export function handlePausePolling(params: PausePollingParams): ToolResult {
  const state = setSweepPaused(true, params.reason);
  return ok({
    paused: state.delivery_paused,
    reason: state.pause_reason,
    busy_mode: state.busy_mode,
    updated_at: state.updated_at,
  });
}

export function handleResumePolling(): ToolResult {
  const state = setSweepPaused(false);
  return ok({
    paused: state.delivery_paused,
    reason: state.pause_reason,
    busy_mode: state.busy_mode,
    updated_at: state.updated_at,
  });
}

export function handlePollingStatus(): ToolResult {
  const state = getSweepControlState();
  return ok({
    paused: state.delivery_paused,
    reason: state.pause_reason,
    busy_mode: state.busy_mode,
    updated_at: state.updated_at,
  });
}

export function handleSetPollingBusy(params: SetPollingBusyParams): ToolResult {
  const mode = params.mode;
  if (!mode) {
    return err('Missing required param: mode (auto|manual_busy|manual_free)');
  }
  if (mode !== 'auto' && mode !== 'manual_busy' && mode !== 'manual_free') {
    return err(`Invalid mode: ${mode}. Use auto|manual_busy|manual_free`);
  }
  const state = setSweepBusyMode(mode);
  return ok({
    paused: state.delivery_paused,
    reason: state.pause_reason,
    busy_mode: state.busy_mode,
    updated_at: state.updated_at,
  });
}
