/**
 * In-memory SQLite helpers for tests that need a live DB without touching
 * the real crew state directory.
 *
 * Usage:
 *   const db = setupTestDb();
 *   // ... register agents, rooms, etc. via src/state functions
 *   teardownTestDb(db);
 */

import { closeDb, initDb } from '../../src/state/index.ts';

/**
 * Point the global DB singleton at a fresh in-memory database and initialize
 * the schema. Returns the path token used (always ':memory:').
 */
export function setupTestDb(): string {
  initDb(':memory:');
  return ':memory:';
}

/** Close and discard the in-memory DB. */
export function teardownTestDb(): void {
  closeDb();
}
