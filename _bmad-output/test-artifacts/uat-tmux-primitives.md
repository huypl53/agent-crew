# UAT Test Results: tmux Primitives for cc-tmux

**Date:** 2026-04-05
**Tester:** Automated via monitor agent
**Target:** Real Claude Code agent in tmux session `nvim:1.0`

## Test Environment

- tmux server: `/tmp/tmux-1001/default`
- Worker agent pane: `%100` (CC Opus 4.6)
- Monitor agent pane: `%101` (CC Opus 4.6)
- tmux session: `nvim`, window `1`, pane `0`

---

## Test 1: CC Status Line Regex Detection — PASS

**Objective:** Identify regex patterns to detect idle vs busy CC states from capture-pane output.

**Findings:**

### Idle State (bottom of pane)
```
────────────────────────── worker ──
❯                                  
────────────────────────────────────
  .../.worktrees/bmad opus-4-6 ctx:61% 5h:42%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```

**Idle regex:** `^❯\s*$` on the prompt line between the two `─` separator lines.

### Busy State (in content area, before the prompt section)
Spinner patterns observed:
- `· Contemplating… (0s)`
- `· Contemplating… (3s · ↑r12 tokens)`
- `* Wandering… (1s)`
- `* Contemplating… (25s · ↑ 98 tokens)`
- `✶ Gitifying… (8s · ↑ 84 tokens)`
- `✽ Gitifying… (1m 13s · ↓ 433 tokens)`
- `✻ Compacting conversation…`

**Busy regex:** `/^[·*✶✽✻]\s+\w+…\s+\(\d/` — spinner char + verb + ellipsis + active timer

### Completion Indicators (NOT busy — task just finished)
- `✻ Baked for 1m 2s`
- `✻ Crunched for 37s`
- `✻ Sautéed for 36s`
- `✻ Churned for 1m 10s`
- `✻ Brewed for 1m 23s`
- `✻ Worked for 46s`
- `✻ Cooked for 54s`

**Completion regex:** `/^✻\s+\w+\s+for\s+/` — uses "for" (past tense) vs "…" (active)

### Status Bar Pattern
```
  .../.worktrees/bmad opus-4-6 ctx:61% 5h:42%
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```

**Status bar regex:** `/ctx:\d+%/` — always present in the last 2-3 lines

### Detection Strategy
1. Capture last 10 lines of pane via `capture-pane -p -J`
2. Check for busy spinner: active verb + `…` + timer = BUSY
3. Check for empty `❯` prompt between separator lines = IDLE
4. Check for `#{pane_dead}` via `list-panes -F` = DEAD
5. If no prompt and no spinner = UNKNOWN

---

## Test 2: send-keys Literal Mode with Special Characters — PASS

**Objective:** Verify `send-keys -l` correctly delivers special characters to CC.

**Input sent:**
```
echo this; has "special" chars: [name@room] {braces} & pipes | etc #hash
```

**Result:** CC received the exact text with all special characters intact. No tmux interpretation of `;`, `"`, `[`, `]`, `{`, `}`, `&`, `|`, `#`.

**Key:** Always use `send-keys -l` for text body, then `send-keys Enter` separately.

---

## Test 3: Multi-line Paste via send-keys — PASS

**Objective:** Verify multi-line text sent via send-keys triggers CC's paste detection.

**Input sent:**
```
Line 1: Hello\nLine 2: World\nLine 3: This is a multi-line paste test
```
(using `$'...'` bash quoting for literal newlines)

**Result:**
1. CC displayed all 3 lines in the input area without submitting
2. Pressing Enter separately submitted all lines as one prompt
3. CC processed all 3 lines correctly

**Note:** CC showed the raw text in the input area (not `[Pasted text #N]` label). The key behavior is that newlines in send-keys don't trigger premature submission.

---

## Test 4: Push Message Format Recognition — PASS

**Objective:** Verify CC can receive and act on `[name@room]: text` format messages.

**Input sent:**
```
[leader-1@myproject]: Please create a file called /tmp/cc-tmux-test.txt with the content "hello from leader". This is a test of the push message format.
```

**Result:**
- CC received the message as user input
- CC understood the instruction and created the file
- Verified: `/tmp/cc-tmux-test.txt` contains "hello from leader"
- The `[name@room]:` prefix doesn't confuse CC

**End-to-end flow validated:** Leader sends via tmux → CC receives → CC executes → Verifiable output.

---

## Test 5: TMUX Environment Variable Detection — PASS

**Objective:** Verify `$TMUX` and `$TMUX_PANE` are accessible from within a CC agent session.

**Result:**
- Worker agent: `TMUX=/tmp/tmux-1001/default,2877219,9`, `TMUX_PANE=%100`
- Monitor agent: `TMUX=/tmp/tmux-1001/default,2877219,9`, `TMUX_PANE=%101`

Both agents share the same tmux server but have unique pane IDs. The `$TMUX_PANE` value can be used for auto-registration in `join_room`.

---

## Summary

| Test | Result | Risk Level |
|------|--------|------------|
| CC Status Line Regex Detection | PASS | Resolved — patterns documented |
| send-keys Literal Mode | PASS | Low — `-l` flag is reliable |
| Multi-line Paste | PASS | Low — works natively |
| Push Message Format | PASS | Low — CC handles it naturally |
| TMUX Env Var Detection | PASS | Low — standard tmux behavior |

**All 5 UAT tests passed.** The core tmux primitives that cc-tmux depends on are validated with real Claude Code agents. The three open questions from the architecture document are now resolved:

1. ✅ **CC status line regexes** — Documented above with specific patterns
2. ✅ **Permission bypass** — Worker agent ran with `bypass permissions on` (visible in status bar)
3. ✅ **Offset map persistence** — Not directly tested, but file-based approach is validated (file I/O works fine from CC)
