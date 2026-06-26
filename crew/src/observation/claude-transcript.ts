export interface InspectionTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
}

interface TranscriptContentBlock {
  type?: string;
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | TranscriptContentBlock[];
  };
}

function extractText(
  content: string | TranscriptContentBlock[] | undefined,
): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!Array.isArray(content)) return null;

  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text?.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return text.length > 0 ? text : null;
}

export function extractRecentClaudeTurns(
  content: string,
  limit: number,
): InspectionTurn[] {
  if (!content.trim() || limit <= 0) return [];

  const turns: InspectionTurn[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    const role =
      entry.type === 'user' || entry.type === 'assistant'
        ? entry.type
        : entry.message?.role === 'user' || entry.message?.role === 'assistant'
          ? entry.message.role
          : null;

    if (!role) continue;

    const text = extractText(entry.message?.content);
    if (!text) continue;

    turns.push({
      role,
      text,
      timestamp: entry.timestamp ?? null,
    });
  }

  return turns.slice(-limit);
}

// ---------------------------------------------------------------------------
// AGY (Antigravity) transcript parser
// AGY transcript schema per step:
//   { step_index, source: "MODEL"|"USER_EXPLICIT"|"SYSTEM", type: "PLANNER_RESPONSE"|"USER_INPUT"|..., content: string, ... }
// ---------------------------------------------------------------------------

interface AgyTranscriptEntry {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
}

export function extractRecentAgyTurns(
  content: string,
  limit: number,
): InspectionTurn[] {
  if (!content.trim() || limit <= 0) return [];

  const turns: InspectionTurn[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let entry: AgyTranscriptEntry;
    try {
      entry = JSON.parse(line) as AgyTranscriptEntry;
    } catch {
      continue;
    }

    // Only include user-visible turns
    const type = entry.type ?? '';
    if (type !== 'PLANNER_RESPONSE' && type !== 'USER_INPUT') continue;

    const source = entry.source ?? '';
    const role: 'user' | 'assistant' | null =
      source === 'MODEL'
        ? 'assistant'
        : source === 'USER_EXPLICIT' || source === 'USER'
          ? 'user'
          : null;

    if (!role) continue;

    const text = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!text) continue;

    turns.push({ role, text, timestamp: null });
  }

  return turns.slice(-limit);
}
