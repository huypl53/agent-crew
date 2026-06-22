/**
 * Static model → context window limit mapping.
 * Prefix-matched so "claude-sonnet-4-6-20250514" → 200_000.
 */

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-8': 200_000,
  'claude-opus-4-7': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5-20250514': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'glm-5.1': 200_000,
  'gpt-4.1': 1_047_576,
  'o3': 200_000,
  'o4-mini': 200_000,
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Get context window limit for a model name. Uses prefix matching. */
export function getContextLimit(model: string): number {
  // Exact match first
  const exactLimit = MODEL_CONTEXT_LIMITS[model];
  if (exactLimit !== undefined) return exactLimit;

  // Prefix match: try progressively shorter prefixes
  const keys = Object.keys(MODEL_CONTEXT_LIMITS);
  for (const key of keys) {
    if (model.startsWith(key) || key.startsWith(model)) {
      const matchedLimit = MODEL_CONTEXT_LIMITS[key];
      if (matchedLimit !== undefined) return matchedLimit;
    }
  }

  return DEFAULT_CONTEXT_LIMIT;
}
