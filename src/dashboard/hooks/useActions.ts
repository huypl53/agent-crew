import { useState, useCallback, useEffect } from 'react';

export interface PendingAction {
  label: string;           // e.g. "Revoke wk-01?"
  execute: () => Promise<void>;
}

interface Feedback {
  text: string;
  type: 'success' | 'error';
}

interface TextInputState {
  prompt: string;
  onSubmit: (text: string) => void;
}

export interface UseActionsReturn {
  pendingAction: PendingAction | null;
  feedback: Feedback | null;
  textInput: TextInputState | null;
  requestAction: (action: PendingAction) => void;
  confirm: () => void;
  cancel: () => void;
  showFeedback: (text: string, type: 'success' | 'error') => void;
  requestTextInput: (prompt: string, onSubmit: (text: string) => void) => void;
  cancelTextInput: () => void;
  isBlocking: boolean;  // true when confirm or textInput is active
}

export function useActions(): UseActionsReturn {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [textInput, setTextInput] = useState<TextInputState | null>(null);

  // Auto-dismiss feedback after 3 seconds
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const requestAction = useCallback((action: PendingAction) => {
    setPendingAction(action);
  }, []);

  const showFeedback = useCallback((text: string, type: 'success' | 'error') => {
    setFeedback({ text, type });
  }, []);

  const confirm = useCallback(async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    try {
      await action.execute();
      showFeedback(action.label.replace('?', '') + ' — done', 'success');
    } catch (e) {
      showFeedback(`Error: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [pendingAction, showFeedback]);

  const cancel = useCallback(() => {
    setPendingAction(null);
    setTextInput(null);
  }, []);

  const requestTextInput = useCallback((prompt: string, onSubmit: (text: string) => void) => {
    setTextInput({ prompt, onSubmit });
  }, []);

  const cancelTextInput = useCallback(() => {
    setTextInput(null);
  }, []);

  const isBlocking = pendingAction !== null || textInput !== null;

  return {
    pendingAction, feedback, textInput,
    requestAction, confirm, cancel,
    showFeedback, requestTextInput, cancelTextInput,
    isBlocking,
  };
}
