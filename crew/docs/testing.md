# Testing

How to run and reason about the crew test suite. Read this before adding tests
or debugging a red suite.

## Run it

```sh
bun run test
```

This expands to `bun test --isolate --timeout 15000`. **Always go through the
script — do not run bare `bun test`.** The `--isolate` flag is load-bearing
(see [Why `--isolate`](#why---isolate)).

Current state: 520 passing across 42 files.

## Why `--isolate`

A few test files (`test/tool-commands.test.ts`,
`test/pane-queue-bootstrap.test.ts`, `test/lib/fixture-runner.ts`) call
`bun:test`'s `mock.module()` to stub the entire `src/tmux/index.ts` module.

In Bun 1.3.13 `mock.module()` is **process-global and irreversible**:
`mock.restore()` does not undo it, and re-registering real exports does not
work. Without isolation, once the first such file runs, every later file in the
process sees `getPaneCwd → null`, `paneExists → true`, etc., and cascades.

`--isolate` gives each test file a fresh global/module registry, so the mock
stays scoped to the file that declared it. (`isolate = true` under `[test]` in
`bunfig.toml` is **not honored** by Bun 1.3.13 — only the CLI flag works, which
is why it lives in the `package.json` script.)

If you ever see dozens of unrelated `NO_CWD` / join-room / tmux failures
suddenly appear, the first thing to check is whether someone ran `bun test`
without the flag.

## Two layers — they cover different things

### Layer 1: mock-hook + mock-tmux fixtures (fast, deterministic)

- `test/lib/mock-hook.ts` (`MockHook`) replays the **payload** a Claude Code
  hook would send (Stop, UserPromptSubmit, malformed, concurrent) directly into
  the handler `src/tools/hook-event.ts`.
- `test/lib/fixture-runner.ts` + `test/fixtures/hooks/*.fixture.json` are
  data-driven: each JSON file seeds rooms/agents/goals/hints, fires a sequence
  of hook events, and asserts on stdout, persisted hook-event state, and
  recorded tmux side effects. Fixture steps share a stable default session id
  per pane (and one shared id for no-pane flows) unless they explicitly
  override it. Current hook fixtures also cover session-only hooks, rebinding,
  permission-request auto-allow, and stale/mismatched pane edge cases. The tmux
  module is mocked; calls land in a `_tapLog` (`TmuxTap`) for assertion.
  **Adding an edge case = adding a JSON file, no test code changes.**
- Driven by `test/hook-fixture.test.ts`.

**Boundary:** these tests **assume tmux delivery succeeds** (`sendKeys` always
returns `{ delivered: true }`). They do **not** exercise the real delivery path,
pane queue, pacing, or pane liveness. That is Layer 2's job. Don't extend a
fixture to assert on delivery semantics it cannot actually see.

Also: `MockHook` fakes the hook **payload**, not real Claude Code. It tests
crew's hook handler, not the live Claude Code ↔ crew wiring. For true overlap
or in-flight races, prefer dedicated unit tests using `MockHook.concurrent()`;
fixture JSONs are best for deterministic replay sequences.

### Layer 2: real tmux (integration)

- `test/helpers.ts` spins up real `/bin/sh` panes on an isolated socket
  (`crew-test-<pid>`, sessions prefixed `cc-test-<pid>-`) and offers
  `createTestSession`, `sendToPane`, `sendPaneMarker`, `captureFromPane`,
  `capturePaneAfterMarker`, and the waiters `waitForPaneToContain`,
  `waitForPaneAfterMarkerToContain`, `assertPaneAfterMarkerLacks`.
- `waitForPaneOutput` uses tmux **control mode** (`-C attach`) to listen on live
  `%output` lines — more reliable than polling `capture-pane`. Prefer it for new
  tests; pass the triggering action in `onReady` (fires after `%end`) to avoid a
  startup race.
- `test/lib/tmux-watch-runner.ts` powers JSON fixtures in
  `test/fixtures/tmux-watch/*.fixture.json`. In addition to plain tmux text
  triggers, it now has a deliberately tiny set of crew-aware actions:
  `crew-join-room`, `crew-input-block`, and `crew-hook-event`.
  It also has a runner utility, `capture-pane`, for mid-sequence absence checks.
  Keep that surface narrow; it is there to prove live runtime contracts, not to
  become a second generic tool API.
- Used by `test/send-batch.test.ts`, `test/block-unblock-flush.test.ts`,
  `test/input-block-unblock-flush.test.ts`, `test/pane-queue-bootstrap.test.ts`,
  `test/tmux-watch.test.ts`, and similar.

**Boundary:** real-tmux tests are inherently timing-sensitive (polling /
control-mode / `Bun.sleep`). Keep timeouts generous, prefer event-driven waits
over fixed sleeps, and isolate each test's sessions via the tag-based
`cleanupAllTestSessions()`.

## tmux socket isolation & `exit-empty`

Tests share one `crew-test-<pid>` socket per process. tmux defaults to
`exit-empty on`, which tears down the **entire server** when the last session on
a socket is killed; the next `new-session` then resurrects a server whose
monotonic pane IDs reset to `%0`. Files still holding old pane IDs would then
reference the wrong (reused) pane and fail with spurious `NO_CWD` errors.

`test/helpers.ts` handles this by setting `exit-empty off` once per process
(`ensureServerPersists`) and `kill-server`-ing the socket on process exit
(`registerExitCleanup`). If you bypass `createTestSession` and talk to tmux
directly in a test, reuse the same socket helpers — don't spawn a bare
`crew-test-*` server.

The socket is selected via `CREW_TMUX_SOCKET`; `test/helpers.ts` sets it for the
process. This is separate from your live tmux sessions on the `default` socket.

## Known gaps

- `test/uat-edge-cases.ts` and `test/uat-no-ack-regression.ts` (standalone UAT
  scripts, not part of `bun test`) currently fail `bun run typecheck` with
  `string → number` argument mismatches. They are not loaded by the suite and
  are pre-existing tech debt; fix when you next touch them.
- `hooks-export.json` at the repo root is a generated artifact — do not edit or
  commit it from test work.
