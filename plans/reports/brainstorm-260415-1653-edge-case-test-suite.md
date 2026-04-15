# Brainstorm: Edge Case Test Suite for Agent Communication

**Date:** 2026-04-15  
**Status:** Approved  
**Next:** Implementation plan

---

## Problem Statement

Current UAT tests (`uat-send-reliability.ts`) verify happy-path delivery but don't cover edge cases:
- Pane failures mid-delivery
- Status detection edge cases
- Sender verification bypass attempts
- Multi-agent coordination under stress

Need comprehensive edge case tests in isolated tmux environment.

---

## Evaluated Approaches

### 1. Separate tmux socket (Selected)
- `tmux -L crew-uat-edge` — fully isolated server
- Zero risk to user's real sessions
- Auto-cleanup via trap + finally
- **Selected: Best isolation with minimal overhead**

### 2. Dedicated session in current server
- Simpler setup
- Risk: Interferes with user's work if tests hang
- **Rejected: Not isolated enough**

### 3. Docker container
- Full isolation
- Slow startup, overkill for local dev
- **Rejected: Too heavy for iteration speed**

---

## Mock Agent Design

Bash script with controllable modes via touch file:

```bash
MODE=${1:-idle}  # idle | busy | dead | chaos

emit_idle() { echo "❯"; }
emit_busy() { echo "✶ Working… (${SECONDS}s)"; }

while true; do
  # Check mode file for dynamic switching
  [[ -f /tmp/${AGENT_NAME}.mode ]] && MODE=$(cat /tmp/${AGENT_NAME}.mode)
  case $MODE in
    idle)  emit_idle; read -t 0.5 input && echo "RX: $input" ;;
    busy)  emit_busy; sleep 1 ;;
    dead)  exit 0 ;;
    chaos) [[ $((RANDOM%2)) -eq 0 ]] && emit_idle || emit_busy; sleep 0.5 ;;
  esac
done
```

---

## Test Scenarios (17 Total)

### Delivery Failures (E1-E5)
| ID | Scenario | Setup | Assertion |
|----|----------|-------|-----------|
| E1 | Pane dies mid-delivery | Kill pane after paste, before Enter | `delivered: false`, error message |
| E2 | Enter retry exhaustion | Agent ignores Enter (no content change) | 3 retries, warning logged |
| E3 | 10KB message | Send 10,000 char payload | Full text in pane, no truncation |
| E4 | Special chars | `\x00`, `$()`, backticks, emoji | Literal preservation in pane |
| E5 | Rapid-fire 10 msgs | 10 messages <100ms apart | All arrive in order |

### Status Detection (E6-E8)
| ID | Scenario | Setup | Assertion |
|----|----------|-------|-----------|
| E6 | Unknown + changing content | Agent outputs random lines | Never ready until 2 stable polls |
| E7 | Busy timeout | Agent stuck busy >10s | Delivers after MAX_WAIT_MS |
| E8 | Status buried | 200 lines output before status | Still detects from tail-20 |

### Queue/Polling (E9-E11)
| ID | Scenario | Setup | Assertion |
|----|----------|-------|-----------|
| E9 | Queue 20 messages | Slow target, 20 rapid sends | FIFO order, all delivered |
| E10 | Heartbeat stale | No activity 30s+ | Interval falls to 500ms |
| E11 | Role intervals | Worker/leader/boss agents | 2s/5s/10s respectively |

### Sender Verification (E12-E13)
| ID | Scenario | Setup | Assertion |
|----|----------|-------|-----------|
| E12 | Spoofed TMUX_PANE | Set wrong pane in env | Log mode: warn; Enforce mode: reject |
| E13 | No TMUX_PANE | Unset env var | Verification skipped |

### Integration (E14-E17)
| ID | Scenario | Setup | Assertion |
|----|----------|-------|-----------|
| E14 | Stale pane | Pane shows bash, not agent | Agent marked stale, queued |
| E15 | Broadcast partial | 5 targets, 2 dead | delivered=3, queued=5 |
| E16 | Worker notify leader | Completion kind message | Leader gets auto-notification |
| E17 | 3 concurrent senders | Parallel sends to 1 target | All delivered, mutex holds |

---

## File Structure

```
crew/test/
├── uat-edge-cases.ts          # Main runner (17 tests)
├── fixtures/
│   └── mock-agent.sh          # Controllable mock
└── lib/
    └── edge-test-harness.ts   # tmux socket setup/teardown
```

---

## Implementation Considerations

1. **Isolation**: Socket name includes timestamp to avoid collision on reruns
2. **Cleanup**: Robust cleanup even on SIGINT/SIGTERM
3. **Control**: File-based mode switching (touch `/tmp/agent-N.mode`)
4. **Timing**: Use explicit waits, not sleep loops
5. **Assertions**: Simple pass/fail with context on failure

---

## Success Criteria

- [ ] All 17 edge cases have passing tests
- [ ] Tests run in <60s total
- [ ] Zero interference with user's real tmux session
- [ ] Clear failure messages with context
- [ ] Exit code 1 on any failure

---

## Next Steps

1. Create implementation plan with phases
2. Delegate to worker agent for implementation
3. Run tests in feat/delivery-ack branch
4. Document in plan.md before merge
