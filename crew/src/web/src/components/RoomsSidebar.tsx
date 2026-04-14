import React, { useEffect, useState } from 'react';
import type { Room } from '../types.ts';
import { get } from '../hooks/useApi.ts';

interface Props {
  selectedRoom: string | null;
  onSelect: (room: string) => void;
}

export default function RoomsSidebar({ selectedRoom, onSelect }: Props) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Room[]>('/rooms')
      .then(setRooms)
      .catch(e => setError((e as Error).message));
    const id = setInterval(() => {
      get<Room[]>('/rooms').then(setRooms).catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside className="w-56 flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400 border-b border-slate-700">
        Rooms
      </div>
      {error && <div className="p-2 text-xs text-red-400">{error}</div>}
      <ul className="flex-1 overflow-y-auto">
        {rooms.map(room => (
          <li key={room.name}>
            <button
              onClick={() => onSelect(room.name)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700 transition-colors ${selectedRoom === room.name ? 'bg-slate-700 text-white font-medium' : 'text-slate-300'}`}
            >
              <div className="truncate">#{room.name}</div>
              <div className="text-xs text-slate-500 truncate">
                {room.members.length} member{room.members.length !== 1 ? 's' : ''}
                {room.topic ? ` · ${room.topic}` : ''}
              </div>
            </button>
          </li>
        ))}
        {rooms.length === 0 && !error && (
          <li className="px-3 py-2 text-xs text-slate-500">No rooms</li>
        )}
      </ul>
    </aside>
  );
}
