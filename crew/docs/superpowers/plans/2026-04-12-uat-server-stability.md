# UAT Plan: Server Stability (Task 10)

## Goal

Verify that crash-guard handlers are registered, the health heartbeat fires correctly,
and the `server-log` module writes, appends, rotates, and never throws.

Note: `src/shared/server-log.ts` already has unit tests in `test/server-log.test.ts`.
This UAT plan covers the integration-level behaviours — handler registration and heartbeat
output — that unit tests do not reach.

---

## Prerequisites

- A temp `CREW_STATE_DIR` (per test, cleaned up after)
- `initServerLog(path)` called with a path inside that temp dir
- For crash-guard tests: access to the running process's handler list via
  `process.rawListeners('uncaughtException')` etc. — no real crashes needed
- For heartbeat test: ability to trigger the interval callback manually (extract it)
  or spawn the server as a subprocess and check its log

---

## Test Cases

### Server-Log Module

**TC-L1 — Write and read back**
1. `initServerLog('/tmp/crew-uat-<pid>/server.log')`.
2. `logServer('INFO', 'hello world')`.
3. Read file.
4. Expected: file exists; line contains `[INFO] hello world` and an ISO-8601 timestamp.

**TC-L2 — Append across multiple calls**
1. Call `logServer` three times with different messages.
2. Expected: file has exactly three non-empty lines in order.

**TC-L3 — Rotation at 1 MB**
1. Write 600 lines of ~2 KB each (total ~1.2 MB).
2. Expected: file line count is ≤ 500; last line contains the last-written message.

**TC-L4 — Never throws on bad path**
1. `initServerLog('/dev/null/impossible/server.log')`.
2. Call `logServer('INFO', 'test')`.
3. Expected: no exception thrown.

> TC-L1–L4 overlap with `test/server-log.test.ts`. The UAT script should import the same
> module and re-verify in a subprocess-style context (real filesystem, not mocked) to confirm
> it works end-to-end outside the unit test harness.

---

### Crash Guard Registration

**TC-G1 — uncaughtException handler is registered**
1. Import `src/index.ts` as a child process OR inspect handler counts before/after
   the guard setup code runs.
2. Expected: `process.listenerCount('uncaughtException')` ≥ 1.

**TC-G2 — unhandledRejection handler is registered**
1. Same approach as TC-G1.
2. Expected: `process.listenerCount('unhandledRejection')` ≥ 1.

**TC-G3 — SIGHUP handler is registered**
1. Expected: `process.listenerCount('SIGHUP')` ≥ 1 after server init.

**TC-G4 — stdin.resume keeps process alive**
1. Verify `process.stdin.isPaused()` returns `false` after server startup.
   (`stdin.resume()` sets paused = false.)

**TC-G5 — uncaughtException does NOT crash the server**
1. Spawn the MCP server as a subprocess (`bun src/index.ts`).
2. Send it a signal or IPC message that triggers a synthetic uncaughtException
   (or simply check that `process.on('uncaughtException', ...)` is wired to a handler that
   calls `logServer` and does NOT call `process.exit`).
3. Inspect server.log for `[ERROR] uncaughtException:`.
4. Expected: process is still alive after ≥ 1 second; log line present.

> TC-G5 is the most complex. An acceptable lighter alternative: read `src/index.ts` source,
> confirm the handler body contains no `process.exit` call.

---

### Health Heartbeat

**TC-H1 — Heartbeat writes to server.log**
1. Spawn `bun src/index.ts` with `CREW_STATE_DIR` pointing to a temp dir.
2. Wait enough for at least one heartbeat (interval is 5 minutes — for UAT, either:
   a. Modify the interval to 2 s via an env var `CREW_HEALTH_INTERVAL_MS`, OR
   b. Extract the heartbeat callback from `src/index.ts` and call it directly in a
      test harness without spawning the server).
3. Read server.log.
4. Expected: at least one line matching `[HEALTH]` containing `rss=`, `heap=`,
   `agents=`, `uptime=`.

**TC-H2 — Heartbeat format**
1. Parse a `[HEALTH]` line from server.log.
2. Expected fields present: `rss=<N>MB`, `heap=<N>MB`, `agents=<N>`, `uptime=<N>s`.
   All values are numeric.

---

## Implementation Notes

### Script location
`test/uat-server-stability.ts`

### Approach for crash guards
The simplest approach that avoids spawning a server is to directly `import` the guard
registration code from a thin helper that `src/index.ts` calls, then check listener counts.
If crash guards are inline in `src/index.ts`, use a subprocess with a short timeout and
inspect via IPC or log output.

### Approach for heartbeat
Recommended: extract the heartbeat function into a named export in `src/index.ts`
(e.g. `export function emitHealthLog()`) and call it directly in the test. This avoids
the 5-minute wait and keeps the test fast. If not extracted, spawn the server with
`CREW_HEALTH_INTERVAL_MS=500` env support added.

### Running
```
bun test/uat-server-stability.ts
```
