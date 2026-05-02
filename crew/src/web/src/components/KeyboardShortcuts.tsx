import React, { useRef } from 'react';
import { useFocusTrap } from './a11y-utils.ts';

interface KeyboardShortcutsProps {
  onClose: () => void;
}

export default function KeyboardShortcuts({ onClose }: KeyboardShortcutsProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const shortcuts = [
    { key: '⌘K / Ctrl+K', desc: 'Open command palette' },
    { key: '?', desc: 'Show keyboard shortcuts' },
    { key: 'j', desc: 'Move down (next item)' },
    { key: 'k', desc: 'Move up (previous item)' },
    { key: 'Enter / Space', desc: 'Select item / toggle expand' },
    { key: '↑ / ↓', desc: 'Navigate up / down' },
    { key: '← / →', desc: 'Collapse / expand' },
    { key: 'Escape', desc: 'Close modal / deselect' },
  ];

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4 border border-slate-200 dark:border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-700 dark:text-slate-100">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 dark:text-slate-400 hover:text-slate-500 dark:hover:text-slate-200 transition-colors p-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          <table className="w-full text-sm">
            <tbody>
              {shortcuts.map((s, i) => (
                <tr
                  key={i}
                  className={
                    i !== shortcuts.length - 1
                      ? 'border-b border-slate-200 dark:border-slate-700/50'
                      : ''
                  }
                >
                  <td className="py-2 pr-4">
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-900 rounded text-slate-700 dark:text-slate-200 font-mono text-xs border border-slate-300 dark:border-slate-600">
                      {s.key}
                    </kbd>
                  </td>
                  <td className="py-2 text-slate-600 dark:text-slate-300">{s.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-400 dark:text-slate-500 text-center">
          Press Escape or click outside to close
        </div>
      </div>
    </div>
  );
}
