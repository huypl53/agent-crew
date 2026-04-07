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
    </>
  );
}
