# tmux-watch Fixtures

These fixtures are for the live tmux-watch layer, not the deterministic hook replay layer.

## Executable fixtures

Files in this directory root are auto-loaded by `test/tmux-watch.test.ts`.
They run on the isolated test tmux socket created by `test/helpers.ts`, not on the user's default tmux server.

Current executable coverage:
- `send-keys-appears-in-pane.fixture.json` — proves the isolated test socket, pane creation, trigger actions, watch loop, and final capture assertions are wired correctly.
- `tmux-send-command-prints-shell-output.fixture.json` — proves `tmux-send-command` can execute a shell command whose emitted marker becomes watchable pane output.
- `multi-action-ordered-pane-output.fixture.json` — proves multiple trigger actions land in pane output in the expected order.
- `timeout-when-pattern-never-appears.fixture.json` — proves timeout expectations and negative final-capture absence checks work when the watched pattern never appears.
- `blocked-stop-flush-after-unblock.fixture.json` — proves a real worker `Stop` completion stays queued while the leader is blocked and appears only after explicit unblock.

## Crew-aware live trigger actions

The live runner now supports a deliberately small set of crew-aware actions in addition to plain tmux text triggers:
- `crew-join-room` — joins a pane-backed agent into a real room through `handleJoinRoom()`.
- `crew-input-block` — toggles block/unblock state through `handleInputBlock()`.
- `crew-hook-event` — injects a real hook payload through `processHookEventInput()`.

It also supports one runner utility action:
- `capture-pane` — snapshots pane output mid-sequence for absence checks before later actions flush queued delivery.

These are runner-specific test affordances, not a generic control plane.
They exist only to cover live runtime contracts that replay fixtures cannot prove.

## Why blocked-stop-flush-after-unblock is live-only

That scenario asks runtime questions:
- was delivery actually held while blocked?
- did output appear only after unblock?
- did the pane output preserve the right order?

Mocked replay cannot prove those things. It can only prove state/effect intent.

## Current runtime proof point

`blocked-stop-flush-after-unblock.fixture.json` is the first crew-aware live scenario. It joins real leader/worker panes into a room, blocks the leader, fires a worker `Stop` hook, proves the completion marker is absent while blocked, then unblocks and verifies the marker appears afterward in the right order.
