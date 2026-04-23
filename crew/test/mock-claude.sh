#!/bin/bash
# Mock Claude Code agent for testing
# Simulates CC status line behavior: shows idle prompt, accepts input, shows busy spinner

echo "Mock Claude Code Agent"
echo "────────────────────────── worker ──"

while true; do
  echo "❯ "
  read -r input
  if [ -z "$input" ]; then
    continue
  fi
  echo "· Contemplating… (0s)"
  sleep 0.5
  echo "Done: $input"
  echo "────────────────────────── worker ──"
done
