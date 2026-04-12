import { useState, useCallback } from 'react';

export type ViewName = 'dashboard' | 'tasks' | 'timeline';

const VIEW_ORDER: ViewName[] = ['dashboard', 'tasks', 'timeline'];

export function useViews() {
  const [currentView, setCurrentView] = useState<ViewName>('dashboard');

  const cycleView = useCallback(() => {
    setCurrentView(prev => {
      const idx = VIEW_ORDER.indexOf(prev);
      return VIEW_ORDER[(idx + 1) % VIEW_ORDER.length];
    });
  }, []);

  return { currentView, cycleView, setCurrentView };
}
