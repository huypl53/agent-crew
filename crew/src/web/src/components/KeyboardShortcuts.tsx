import React from 'react';

interface KeyboardShortcutsProps {
  onClose: () => void;
}

export default function KeyboardShortcuts({ onClose }: KeyboardShortcutsProps) {
  const shortcuts = [
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
        className="bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4 border border-slate-700"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-slate-100">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors p-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          <table className="w-full text-sm">
            <tbody>
              {shortcuts.map((s, i) => (
                <tr key={i} className={i !== shortcuts.length - 1 ? 'border-b border-slate-700/50' : ''}>
                  <td className="py-2 pr-4">
                    <kbd className="px-2 py-1 bg-slate-900 rounded text-slate-200 font-mono text-xs border border-slate-600">
                      {s.key}
                    </kbd>
                  </td>
                  <td className="py-2 text-slate-300">{s.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-slate-700 text-xs text-slate-500 text-center">
          Press Escape or click outside to close
        </div>
      </div>
    </div>
  );
}
