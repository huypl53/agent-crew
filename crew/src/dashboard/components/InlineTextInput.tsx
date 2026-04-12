import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InlineTextInputProps {
  prompt: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function InlineTextInput({ prompt, onSubmit, onCancel }: InlineTextInputProps) {
  const [value, setValue] = useState('');

  return (
    <Box>
      <Text color="cyan">{prompt}: </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => {
          if (text.trim()) onSubmit(text.trim());
          else onCancel();
        }}
      />
    </Box>
  );
}
