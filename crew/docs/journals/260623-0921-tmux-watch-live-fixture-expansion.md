# tmux-watch live fixture expansion

## Context
Expanded the live tmux-watch layer to cover a real crew runtime contract that replay fixtures cannot prove.

## What changed
- Added a narrow crew-aware action surface to `test/lib/tmux-watch-runner.ts`:
  - `crew-join-room`
  - `crew-input-block`
  - `crew-hook-event`
  - `capture-pane` for mid-sequence absence checks
- Promoted `blocked-stop-flush-after-unblock` from draft to executable live coverage.
- Updated `docs/testing.md` and `test/fixtures/tmux-watch/README.md` to describe the live fixture boundary and the new runtime proof point.

## Impact
- Live tmux-watch tests now verify that a worker `Stop` completion stays queued while the leader is blocked and flushes only after explicit unblock.
- Replay fixtures remain the deterministic layer for hook payload and state coverage.
- The harness stays narrow; no generic control plane or transport refactor was added.

## Verification
- `bun test --isolate --timeout 15000 test/tmux-watch.test.ts`
- `bun run typecheck`
- `bun test --isolate --timeout 15000 test/hook-fixture.test.ts`

## Next
- Keep future live scenarios equally small and runtime-specific.
