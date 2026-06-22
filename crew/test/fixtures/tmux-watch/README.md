# tmux-watch Fixtures

These fixtures are for the live tmux-watch layer, not the deterministic hook replay layer.

## Executable fixtures

Files in this directory root are auto-loaded by `test/tmux-watch.test.ts`.
They run on the isolated test tmux socket created by `test/helpers.ts`, not on the user's default tmux server.

Current executable smoke coverage:
- `send-keys-appears-in-pane.fixture.json` — proves the isolated test socket, pane creation, trigger actions, watch loop, and final capture assertions are wired correctly.

## Draft-only scenarios

Draft runtime scenarios live under `drafts/` so they do **not** count as executable coverage yet.

Current draft:
- `drafts/blocked-stop-flush-after-unblock.fixture.json`

It exists to mark a scenario that belongs in live tmux-watch coverage, not hook replay coverage.
The current tmux-watch runner can create isolated tmux panes on the test socket and watch output, but it does **not yet** have crew-specific trigger actions for:
- firing real hook events into crew runtime
- toggling blocked/unblocked delivery state
- asserting queue drain directly

## Why blocked-stop-flush-after-unblock is live-only

That scenario asks runtime questions:
- was delivery actually held while blocked?
- did output appear only after unblock?
- did the pane output preserve the right order?

Mocked replay cannot prove those things. It can only prove state/effect intent.

## Expected next step

When the live tmux-watch layer grows crew-aware trigger actions, replace the draft trigger with a real sequence that:

1. starts the relevant crew runtime
2. causes a blocked completion/delivery state
3. sends the unblock trigger
4. watches the leader pane for the flushed output
