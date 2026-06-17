# Plugin test run notes (Codex)

- Date: 2026-06-17
- Room used: smoke-live-cli
- Agent context: local Codex + tmux smoke test

## Goal

- Verify Codex plugin for crew can complete a real leader/worker exchange end-to-end.
- Confirm the command path is reliable and identify input/submit requirements.

## Commands used

```bash
codex exec "bun run --cwd crew src/cli.ts join --room smoke-live-cli --role leader --name leader-note-test"
codex exec "bun run --cwd crew src/cli.ts join --room smoke-live-cli --role worker --name worker-note-test"
codex exec "bun run --cwd crew src/cli.ts send --room smoke-live-cli --to worker-note-test --text \"Task: cập nhật ghi chú plugin test run\" --name leader-note-test"
codex exec "bun run --cwd crew src/cli.ts read --name worker-note-test --room smoke-live-cli"
```

## Result

- `crew join` command works consistently for both roles when executed through `codex exec`.
- `crew send` + `crew read` flow confirmed working in smoke room.
- In Codex interactive execution context, `$join-room` was inconsistent in some runs; explicit CLI calls remained reliable.
- For direct tmux key injection, submission must include Enter (`C-m`) or equivalent, otherwise keypresses are dropped.

## Notes

- Keep using explicit CLI invocation for critical checks.
- This file should be appended for each re-run date so we have regression history.
