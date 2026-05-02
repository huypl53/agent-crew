import React, { useEffect, useRef, useState } from 'react';
import { get } from '../hooks/useApi.ts';
import { useFocusTrap } from './a11y-utils.ts';
import type { View } from './NavBar.tsx';

interface SearchItem {
  id: string;
  label: string;
  group: string;
  view: View;
  room?: string;
}

interface Props {
  onSelect: (view: View, room?: string | null) => void;
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

export default function CommandPalette({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  const [selected, setSelected] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(panelRef);

  // Cmd+K / Ctrl+K to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery('');
        setSelected(0);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Fetch searchable items when opened
  useEffect(() => {
    if (!open) return;
    const fetchItems = async () => {
      try {
        const [rooms, tasks] = await Promise.all([
          get<{ name: string }[]>('/rooms'),
          get<{ id: number; summary: string; room: string; assigned_to: string }[]>('/tasks'),
        ]);
        const result: SearchItem[] = [
          ...rooms.map((r) => ({
            id: `room:${r.name}`,
            label: `#${r.name}`,
            group: 'Rooms',
            view: 'dashboard' as View,
            room: r.name,
          })),
          ...tasks.slice(0, 30).map((t) => ({
            id: `task:${t.id}`,
            label: `#${t.id} ${t.summary}`,
            group: 'Tasks',
            view: 'tasks' as View,
          })),
          { id: 'nav:dashboard', label: 'Dashboard', group: 'Views', view: 'dashboard' as View },
          { id: 'nav:tasks', label: 'Tasks', group: 'Views', view: 'tasks' as View },
          { id: 'nav:timeline', label: 'Timeline', group: 'Views', view: 'timeline' as View },
          { id: 'nav:trace', label: 'Trace', group: 'Views', view: 'trace' as View },
          { id: 'nav:templates', label: 'Templates', group: 'Views', view: 'templates' as View },
        ];
        setItems(result);
      } catch {
        setItems([]);
      }
    };
    fetchItems();
  }, [open]);

  const filtered = query
    ? items.filter((i) => fuzzyMatch(query, i.label))
    : items;

  // Reset selection when filter changes
  useEffect(() => {
    setSelected(0);
  }, [query]);

  const handleSelect = (item: SearchItem) => {
    onSelect(item.view, item.room ?? null);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && filtered[selected]) {
      handleSelect(filtered[selected]);
    }
  };

  if (!open) return null;

  // Group filtered results
  const groups = new Map<string, SearchItem[]>();
  for (const item of filtered) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }

  let globalIdx = 0;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        className="bg-slate-800 rounded-lg w-[480px] max-h-[60vh] overflow-hidden border border-slate-600 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search rooms, tasks, views…"
          className="w-full px-4 py-3 bg-transparent text-slate-200 text-sm border-b border-slate-700 focus:outline-none"
          aria-label="Search"
        />
        <div className="overflow-y-auto max-h-[50vh]">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-slate-500 text-sm text-center">
              No results found
            </div>
          )}
          {Array.from(groups.entries()).map(([group, groupItems]) => (
            <div key={group}>
              <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500 bg-slate-800/80">
                {group}
              </div>
              {groupItems.map((item) => {
                const idx = globalIdx++;
                const isSelected = idx === selected;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelected(idx)}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                      isSelected ? 'bg-slate-700 text-white' : 'text-slate-300'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
