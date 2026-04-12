import React from 'react';
import { Box, Text } from 'ink';

interface StatusFeedbackProps {
  text: string;
  type: 'success' | 'error';
}

export function StatusFeedback({ text, type }: StatusFeedbackProps) {
  return (
    <Box>
      <Text color={type === 'success' ? 'green' : 'red'}>{text}</Text>
    </Box>
  );
}
