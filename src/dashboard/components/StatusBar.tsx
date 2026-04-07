import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  hasErrors: boolean;
  showHelp?: boolean;
}

export function StatusBar({ hasErrors, showHelp }: StatusBarProps) {
  return (
    <Box height={1}>
      <Text dimColor>{showHelp ? '?:Close Help' : '↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit'}</Text>
      {hasErrors && <Text color="red"> [!]</Text>}
    </Box>
  );
}
