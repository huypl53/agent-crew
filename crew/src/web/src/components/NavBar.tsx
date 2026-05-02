import React from 'react';

export type View = 'dashboard' | 'tasks' | 'timeline' | 'trace' | 'templates';

interface NavBarProps {
  currentView: View;
  onViewChange: (v: View) => void;
  themeToggle?: React.ReactNode;
}

const TABS: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'trace', label: 'Trace' },
  { id: 'templates', label: 'Templates' },
];

export default function NavBar({ currentView, onViewChange, themeToggle }: NavBarProps) {
  return (
    <nav className="flex border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex-shrink-0" aria-label="Main navigation">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onViewChange(id)}
          aria-current={currentView === id ? 'page' : undefined}
          className={[
            'px-5 py-2 text-sm font-medium border-b-2 transition-colors',
            currentView === id
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200',
          ].join(' ')}
        >
          {label}
        </button>
      ))}
      {themeToggle && (
        <div className="ml-auto flex items-center pr-2">
          {themeToggle}
        </div>
      )}
    </nav>
  );
}
