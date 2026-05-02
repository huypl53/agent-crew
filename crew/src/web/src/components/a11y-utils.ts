import { useEffect, useRef, type RefObject } from 'react';

/** Enter/Space key handler for elements with role="button" */
export function handleKeyboardAction(
  callback: () => void,
  e: React.KeyboardEvent,
) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    callback();
  }
}

/** Keyboard event handler wrapper — use as `onKeyDown={onKeyAction(fn)}` */
export function onKeyAction(callback: () => void) {
  return (e: React.KeyboardEvent) => handleKeyboardAction(callback, e);
}

/** Focus trap hook for modal dialogs */
export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    prevFocusRef.current = document.activeElement as HTMLElement;

    const focusable = el.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    el.addEventListener('keydown', handleKeyDown);
    return () => {
      el.removeEventListener('keydown', handleKeyDown);
      prevFocusRef.current?.focus();
    };
  }, [ref]);
}

/** Shared focus ring classes for dark theme */
export const FOCUS_RING =
  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-slate-900';

/** Focus ring for inputs/selects/textarea (replaces focus:outline-none) */
export const INPUT_FOCUS =
  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-slate-800';
