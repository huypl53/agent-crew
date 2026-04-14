import { describe, it, expect } from 'bun:test';

// Test the seenIds pruning logic extracted from useFeed
// Mirrors the exact logic in src/dashboard/hooks/useFeed.ts

const MAX_MESSAGES = 500;

type Msg = { id: string };

function applyUpdate(prev: Msg[], newItems: Msg[], seenIds: Set<string>): { messages: Msg[]; seenIds: Set<string> } {
  const combined = [...prev, ...newItems];
  if (combined.length > MAX_MESSAGES) {
    const kept = combined.slice(-MAX_MESSAGES);
    const newSeenIds = new Set(kept.map(m => m.id));
    return { messages: kept, seenIds: newSeenIds };
  }
  return { messages: combined, seenIds };
}

describe('useFeed seenIds pruning', () => {
  it('does not prune seenIds when under MAX_MESSAGES', () => {
    const seenIds = new Set<string>();
    const prev = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}` }));
    prev.forEach(m => seenIds.add(m.id));
    const newItems = [{ id: 'new1' }];
    const result = applyUpdate(prev, newItems, seenIds);
    expect(result.messages.length).toBe(11);
    expect(result.seenIds).toBe(seenIds); // same reference — no pruning
  });

  it('prunes seenIds to only kept messages when trimming', () => {
    const seenIds = new Set<string>();
    // Fill prev to MAX_MESSAGES
    const prev = Array.from({ length: MAX_MESSAGES }, (_, i) => ({ id: `old${i}` }));
    prev.forEach(m => seenIds.add(m.id));
    const newItems = [{ id: 'fresh1' }, { id: 'fresh2' }];

    const result = applyUpdate(prev, newItems, seenIds);

    expect(result.messages.length).toBe(MAX_MESSAGES);
    // Evicted ids (old0, old1) must not be in seenIds
    expect(result.seenIds.has('old0')).toBe(false);
    expect(result.seenIds.has('old1')).toBe(false);
    // Kept ids must still be present
    expect(result.seenIds.has('fresh1')).toBe(true);
    expect(result.seenIds.has('fresh2')).toBe(true);
    expect(result.seenIds.has(`old${MAX_MESSAGES - 1}`)).toBe(true);
  });

  it('seenIds size stays bounded at MAX_MESSAGES after repeated overflow', () => {
    let seenIds = new Set<string>();
    let messages: Msg[] = [];

    for (let batch = 0; batch < 10; batch++) {
      const newItems = Array.from({ length: 100 }, (_, i) => ({ id: `b${batch}-${i}` }));
      newItems.forEach(m => seenIds.add(m.id));
      const result = applyUpdate(messages, newItems, seenIds);
      messages = result.messages;
      seenIds = result.seenIds;
    }

    expect(messages.length).toBe(MAX_MESSAGES);
    expect(seenIds.size).toBe(MAX_MESSAGES);
  });
});
