import React, { useState } from 'react';
import type { Room } from '../types.ts';
import { post, del } from '../hooks/useApi.ts';
import { validateRoomName } from '../lib/validators.ts';

export { validateRoomName };

interface Props {
  mode: 'create' | 'delete-confirm';
  room?: Room;
  onClose: () => void;
  onSuccess: () => void;
}

export default function RoomModal({ mode, room, onClose, onSuccess }: Props) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    const err = validateRoomName(name);
    if (err) { setError(err); return; }
    setSaving(true);
    try {
      await post('/rooms', { name: name.trim(), topic: topic.trim() || undefined });
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!room) return;
    setSaving(true);
    try {
      await del(`/rooms/${encodeURIComponent(room.name)}?confirm=true`);
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-slate-800 rounded p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
        {mode === 'create' ? (
          <>
            <h2 className="text-slate-100 font-semibold">Create Room</h2>
            <div className="space-y-2">
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void handleCreate()}
                placeholder="Room name"
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              />
              <input
                value={topic}
                onChange={e => setTopic(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void handleCreate()}
                placeholder="Topic (optional)"
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              />
            </div>
          </>
        ) : (
          <>
            <h2 className="text-slate-100 font-semibold">Delete #{room?.name}?</h2>
            <p className="text-sm text-slate-400">
              This will remove {room?.members.length ?? 0} member{(room?.members.length ?? 0) !== 1 ? 's' : ''} and all messages.
            </p>
          </>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          {mode === 'create' ? (
            <button
              onClick={() => void handleCreate()}
              disabled={saving}
              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white"
            >
              {saving ? '…' : 'Create'}
            </button>
          ) : (
            <button
              onClick={() => void handleDelete()}
              disabled={saving}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 rounded text-sm text-white"
            >
              {saving ? '…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
