import React from 'react';

export type View = 'dashboard' | 'tasks' | 'timeline';

interface NavBarProps {
  currentView: View;
  onViewChange: (v: View) => void;
}

const TABS: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'timeline', label: 'Timeline' },
];

export default function NavBar({ currentView, onViewChange }: NavBarProps) {
  return (
    <nav className="flex border-b border-slate-700 bg-slate-900 flex-shrink-0">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onViewChange(id)}
          className={[
            'px-5 py-2 text-sm font-medium border-b-2 transition-colors',
            currentView === id
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          ].join(' ')}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
