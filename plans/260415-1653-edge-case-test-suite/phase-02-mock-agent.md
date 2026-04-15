# Phase 2: Controllable Mock Agent

**Status:** Pending  
**Priority:** High  
**Effort:** 20 min

---

## Overview

Bash script that simulates Claude Code agent behavior with controllable modes via file-based commands.

---

## File to Create

`crew/test/fixtures/mock-agent.sh`

---

## Implementation

```bash
#!/bin/bash
# Mock agent for edge case testing
# Modes: idle (default), busy, dead, chaos, frozen
# Control: echo "busy" > /tmp/crew-mock-${AGENT_NAME}.mode

AGENT_NAME=${1:-agent}
MODE_FILE="/tmp/crew-mock-${AGENT_NAME}.mode"

# Initialize mode file
echo "idle" > "$MODE_FILE"

emit_idle() {
  echo "────────────────────────── ${AGENT_NAME} ──"
  echo "❯ "
}

emit_busy() {
  echo "✶ Working… (${SECONDS}s)"
}

emit_chaos() {
  # Random status - sometimes idle, sometimes busy
  if [[ $((RANDOM % 2)) -eq 0 ]]; then
    emit_idle
  else
    emit_busy
  fi
}

# Initial idle state
emit_idle

while true; do
  # Check mode file for dynamic switching
  if [[ -f "$MODE_FILE" ]]; then
    MODE=$(cat "$MODE_FILE" 2>/dev/null || echo "idle")
  else
    MODE="idle"
  fi
  
  case $MODE in
    idle)
      # Wait for input with timeout
      if read -t 0.5 input; then
        if [[ -n "$input" ]]; then
          echo "RX: $input"
          # Brief busy then back to idle
          echo "✶ Processing… (0s)"
          sleep 0.3
          emit_idle
        fi
      fi
      ;;
    busy)
      emit_busy
      sleep 1
      ;;
    dead)
      # Clean exit
      rm -f "$MODE_FILE"
      exit 0
      ;;
    chaos)
      emit_chaos
      sleep 0.3
      # Also check for input in chaos mode
      if read -t 0.2 input; then
        [[ -n "$input" ]] && echo "RX: $input"
      fi
      ;;
    frozen)
      # Simulates hung agent - no output, no input processing
      sleep 60
      ;;
    *)
      emit_idle
      sleep 0.5
      ;;
  esac
done
```

---

## Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `idle` | Shows `❯` prompt, echoes input | Normal ready state |
| `busy` | Shows spinner, ignores input | Agent processing |
| `dead` | Exits immediately | Pane death simulation |
| `chaos` | Random idle/busy flips | Content stability testing |
| `frozen` | No output, no input | Hung agent simulation |

---

## Control Interface

```bash
# Switch agent to busy
echo "busy" > /tmp/crew-mock-agent-1.mode

# Kill agent
echo "dead" > /tmp/crew-mock-agent-1.mode

# Make agent chaotic
echo "chaos" > /tmp/crew-mock-agent-1.mode
```

---

## Acceptance Criteria

- [ ] Script runs and shows idle prompt
- [ ] Echoes received input with `RX:` prefix
- [ ] Responds to mode file changes within 0.5s
- [ ] `dead` mode exits cleanly
- [ ] `chaos` mode produces varying output
