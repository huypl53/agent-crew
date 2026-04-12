import React from 'react';
import { Box, Text } from 'ink';
import type { PendingAction } from '../hooks/useActions.ts';

interface ConfirmPromptProps {
  action: PendingAction;
}

export function ConfirmPrompt({ action }: ConfirmPromptProps) {
  return (
    <Box>
      <Text color="yellow">{action.label} </Text>
      <Text dimColor>(y/n)</Text>
    </Box>
  );
}
