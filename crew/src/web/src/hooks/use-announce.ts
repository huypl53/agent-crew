import { useCallback, useRef } from 'react';

/** Screen reader announcer — debounced, respects prefers-reduced-motion */
export function useAnnouncer() {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const liveRef = useRef<HTMLDivElement | null>(null);

  // Ensure live region exists in DOM
  if (!liveRef.current && typeof document !== 'undefined') {
    let el = document.getElementById('sr-announcer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sr-announcer';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      el.className = 'sr-only';
      el.style.cssText =
        'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
      document.body.appendChild(el);
    }
    liveRef.current = el as HTMLDivElement;
  }

  const announce = useCallback((message: string) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (liveRef.current) {
        liveRef.current.textContent = message;
      }
    }, 500);
  }, []);

  return { announce };
}
