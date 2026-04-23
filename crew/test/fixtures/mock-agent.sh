#!/bin/bash
# Mock agent for edge case testing
# Modes: idle (default), busy, dead, chaos, frozen
# Control: echo "busy" > /tmp/crew-mock-${AGENT_NAME}.mode

AGENT_NAME=${1:-agent}
MODE_FILE="/tmp/crew-mock-${AGENT_NAME}.mode"

# Initialize mode file (only set to idle if not pre-set before pane creation)
# Pre-setting allows tests to control the initial output before the main loop starts.
[[ -f "$MODE_FILE" ]] || echo "idle" > "$MODE_FILE"

emit_idle() {
  echo "────────────────────────── ${AGENT_NAME} ──"
  echo "❯ "
}

emit_busy() {
  echo "✶ Working… (${SECONDS}s)"
}

emit_chaos() {
  # Emit rapidly changing content (no idle/busy pattern) so matchStatusLine returns 'unknown'.
  # The queue's UNKNOWN_STABLE_REQUIRED mechanism waits for 2 consecutive stable snapshots.
  echo "chaos-line-$((RANDOM % 1000))"
}

# Initial state: read mode and emit accordingly
_INIT_MODE=$(cat "$MODE_FILE" 2>/dev/null || echo "idle")
case "$_INIT_MODE" in
  idle)    emit_idle ;;
  busy)    emit_busy ;;
  chaos)   emit_chaos ;;
  *)       emit_idle ;;
esac

while true; do
  # Check mode file for dynamic switching
  if [[ -f "$MODE_FILE" ]]; then
    MODE=$(cat "$MODE_FILE" 2>/dev/null || echo "idle")
  else
    MODE="idle"
  fi

  case $MODE in
    idle)
      # Wait for input with timeout (integer for macOS bash compatibility)
      if read -t 1 input; then
        if [[ -n "$input" ]]; then
          echo "RX: $input"
          # Brief processing indicator (does NOT match BUSY_PATTERN so waitForReady is unaffected)
          echo "...processing..."
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
      sleep 1
      # Also check for input in chaos mode
      if read -t 1 input; then
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
