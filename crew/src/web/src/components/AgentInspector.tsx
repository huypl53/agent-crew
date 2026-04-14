import React, { useEffect, useState } from 'react';
import type { Agent } from '../types.ts';
import { get } from '../hooks/useApi.ts';

const STATUS_COLORS: Record<string, string> = {
  busy: 'text-yellow-400', idle: 'text-green-400',
  dead: 'text-red-400', unknown: 'text-slate-500',
};

interface Props {
  room: string | null;
}

export default function AgentInspector({ room }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(null);
    if (!room) { setAgents([]); return; }
    get<Agent[]>(`/rooms/${encodeURIComponent(room)}/members`)
      .then(setAgents)
      .catch(e => setError((e as Error).message));
    const id = setInterval(() => {
      if (!room) return;
      get<Agent[]>(`/rooms/${encodeURIComponent(room)}/members`).then(setAgents).catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [room]);

  const selectAgent = async (name: string) => {
    try {
      const agent = await get<Agent>(`/agents/${encodeURIComponent(name)}`);
      setSelected(agent);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <aside className="w-64 flex-shrink-0 bg-slate-800 border-l border-slate-700 flex flex-col">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400 border-b border-slate-700">
        Agents {room ? `· #${room}` : ''}
      </div>
      {error && <div className="p-2 text-xs text-red-400">{error}</div>}
      <ul className="border-b border-slate-700 overflow-y-auto max-h-48">
        {agents.map(a => (
          <li key={a.name}>
            <button
              onClick={() => selectAgent(a.name)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-700 transition-colors ${selected?.name === a.name ? 'bg-slate-700' : ''}`}
            >
              <span className={`text-xs mr-1 ${STATUS_COLORS[a.status] ?? 'text-slate-500'}`}>●</span>
              <span className="text-slate-200">{a.name}</span>
              <span className="ml-1 text-xs text-slate-500">{a.role}</span>
            </button>
          </li>
        ))}
        {agents.length === 0 && !error && (
          <li className="px-3 py-2 text-xs text-slate-500">No agents</li>
        )}
      </ul>

      {selected && (
        <div className="flex-1 overflow-y-auto p-3 text-xs space-y-2">
          <div>
            <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">Name</div>
            <div className="text-slate-200 font-medium">{selected.name}</div>
          </div>
          <div>
            <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">Role / Status</div>
            <div className="flex gap-2">
              <span className="text-slate-300">{selected.role}</span>
              <span className={STATUS_COLORS[selected.status] ?? 'text-slate-500'}>{selected.status}</span>
            </div>
          </div>
          {selected.tmux_target && (
            <div>
              <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">Pane</div>
              <div className="text-slate-400 font-mono">{selected.tmux_target}</div>
            </div>
          )}
          {selected.persona && (
            <div>
              <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">Persona</div>
              <div className="text-slate-300">{selected.persona}</div>
            </div>
          )}
          {selected.capabilities && (
            <div>
              <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">Capabilities</div>
              <div className="text-slate-300">{selected.capabilities}</div>
            </div>
          )}
          <div>
            <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">Rooms</div>
            <div className="text-slate-400">{selected.rooms.join(', ')}</div>
          </div>
        </div>
      )}
      {!selected && (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-xs">
          Click an agent to inspect
        </div>
      )}
    </aside>
  );
}
