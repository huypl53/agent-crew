import React from 'react';
import { Text } from 'ink';

export function HelpOverlay() {
  return (
    <>
      <Text bold> Keybindings </Text>
      <Text> </Text>
      <Text>  ↑/k    Move up</Text>
      <Text>  ↓/j    Move down</Text>
      <Text>  gg     Jump to top</Text>
      <Text>  G      Jump to bottom</Text>
      <Text>  Enter  Toggle collapse</Text>
      <Text>  ?      Close this help</Text>
      <Text>  q      Quit</Text>
      <Text> </Text>
      <Text dimColor>  ── Filters ──</Text>
      <Text>  1      Toggle tasks</Text>
      <Text>  2      Toggle completions</Text>
      <Text>  3      Toggle errors</Text>
      <Text>  4      Toggle questions</Text>
      <Text>  5      Toggle status</Text>
      <Text>  6      Toggle chat</Text>
      <Text> </Text>
      <Text dimColor>  ── Agent Actions (Dashboard view) ──</Text>
      <Text>  x      Revoke agent (interrupt + remove)</Text>
      <Text>  i      Interrupt current task</Text>
      <Text>  c      Clear worker session</Text>
      <Text> </Text>
      <Text dimColor>  ── Task Actions (Tasks view) ──</Text>
      <Text>  i      Interrupt task</Text>
      <Text>  d      Cancel/delete task</Text>
      <Text>  r      Reassign task</Text>
    </>
  );
}
