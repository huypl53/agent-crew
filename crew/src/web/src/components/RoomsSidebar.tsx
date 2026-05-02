import React, { useEffect, useState } from 'react';
import { get } from '../hooks/useApi.ts';
import type { Room } from '../types.ts';

interface Props {
  selectedRoom: string | null;
  onSelect: (room: string) => void;
  onCreateRoom: () => void;
  onDeleteRoom: (room: Room) => void;
  onEditTopic: (room: Room) => void;
  onEditCast: (room: Room) => void;
  onCloneRoom?: (room: Room) => void;
}

export default function RoomsSidebar({
  selectedRoom,
  onSelect,
  onCreateRoom,
  onDeleteRoom,
  onEditTopic,
  onEditCast,
  onCloneRoom,
}: Props) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Room[]>('/rooms')
      .then(setRooms)
      .catch((e) => setError((e as Error).message));
    const id = setInterval(() => {
      get<Room[]>('/rooms')
        .then(setRooms)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside className="w-56 flex-shrink-0 bg-slate-50 dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col" aria-label="Rooms">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700 flex items-center">
        <span className="flex-1">Rooms</span>
        <button
          onClick={onCreateRoom}
          title="Create room"
          aria-label="Create room"
          className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 leading-none text-base"
        >
          +
        </button>
      </div>
      {error && <div className="p-2 text-xs text-red-400">{error}</div>}
      <ul className="flex-1 overflow-y-auto">
        {rooms.map((room) => (
          <li key={room.name} className="group relative">
            <button
              onClick={() => onSelect(room.name)}
              aria-label={`Select room ${room.name}`}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${selectedRoom === room.name ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-medium' : 'text-slate-700 dark:text-slate-300'}`}
            >
              {/* Room name — extra right padding to clear icon buttons */}
              <div className="truncate pr-24 font-medium">#{room.name}</div>
              <div className="text-xs text-slate-400 dark:text-slate-500 truncate">
                {room.member_count ?? 0} member
                {(room.member_count ?? 0) !== 1 ? 's' : ''}
              </div>
              {room.topic && (
                <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{room.topic}</p>
              )}
              {!!room.template_names?.length && (
                <p className="text-xs text-slate-500 dark:text-slate-600 italic truncate">
                  {room.template_names.join(', ')}
                </p>
              )}
            </button>

            {/* Clone as template — visible on hover */}
            {onCloneRoom && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloneRoom(room);
                }}
                title="Clone as template"
                aria-label="Clone as template"
                className="absolute right-20 top-2 opacity-0 group-hover:opacity-100 text-slate-400 dark:text-slate-500 hover:text-blue-400 text-xs transition-opacity"
              >
                📋
              </button>
            )}
            {/* Edit topic — visible on hover, positioned left of delete */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEditTopic(room);
              }}
              title="Edit topic"
              aria-label="Edit topic"
              className="absolute right-8 top-2 opacity-0 group-hover:opacity-100 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 text-xs transition-opacity"
            >
              ✎
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEditCast(room);
              }}
              title="Edit cast"
              aria-label="Edit cast"
              className="absolute right-14 top-2 opacity-0 group-hover:opacity-100 text-slate-400 dark:text-slate-500 hover:text-blue-400 text-xs transition-opacity"
            >
              👥
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteRoom(room);
              }}
              title="Delete room"
              aria-label="Delete room"
              className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 text-slate-400 dark:text-slate-500 hover:text-red-400 text-xs transition-opacity"
            >
              🗑
            </button>
          </li>
        ))}
        {rooms.length === 0 && !error && (
          <li className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">No rooms</li>
        )}
      </ul>
    </aside>
  );
}
