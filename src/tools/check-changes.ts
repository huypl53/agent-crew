import { ok } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getChangeVersions } from '../state/index.ts';

const VALID_SCOPES = ['messages', 'tasks', 'agents'];

interface CheckChangesParams {
  scopes?: string[];
  name: string;
}

export async function handleCheckChanges(params: CheckChangesParams): Promise<ToolResult> {
  const scopes = (params.scopes ?? VALID_SCOPES).filter(s => VALID_SCOPES.includes(s));
  const versions = getChangeVersions(scopes);
  return ok({ scopes: versions });
}
