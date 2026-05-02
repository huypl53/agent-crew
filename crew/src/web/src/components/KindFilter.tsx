import React from 'react';

const KINDS = [
  { key: 'task', label: 'task', color: 'text-cyan-400' },
  { key: 'completion', label: 'done', color: 'text-green-400' },
  { key: 'error', label: 'error', color: 'text-red-400' },
  { key: 'question', label: '?', color: 'text-yellow-400' },
  { key: 'status', label: 'status', color: 'text-slate-400' },
  { key: 'chat', label: 'chat', color: 'text-slate-300' },
] as const;

interface Props {
  enabledKinds: Set<string>;
  onToggle: (kind: string) => void;
}

export default function KindFilter({ enabledKinds, onToggle }: Props) {
  return (
    <div className="flex gap-1 px-3 py-1 border-b border-slate-200 dark:border-slate-700 flex-wrap">
      {KINDS.map(({ key, label, color }) => {
        const active = enabledKinds.has(key);
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            title={`Toggle ${key} messages`}
            className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
              active
                ? `bg-slate-200 dark:bg-slate-600 ${color}`
                : 'bg-transparent text-slate-600 dark:text-slate-500 hover:text-slate-500'
            }`}
          >
            [{label}]
          </button>
        );
      })}
    </div>
  );
}
