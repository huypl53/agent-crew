import React, { useState } from 'react';
import { del, patch, post } from '../hooks/useApi.ts';
import { validateRoomName } from '../lib/validators.ts';
import type { AgentTemplate, Room } from '../types.ts';

export { validateRoomName };

type RoomModalMode = 'create' | 'delete-confirm' | 'edit-topic' | 'edit-cast';

interface Props {
  mode: RoomModalMode;
  room?: Room;
  templates?: AgentTemplate[];
  onClose: () => void;
  onSuccess: () => void;
}

export default function RoomModal({
  mode,
  room,
  templates = [],
  onClose,
  onSuccess,
}: Props) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState(
    mode === 'edit-topic' ? (room?.topic ?? '') : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Template picker step state (create mode only)
  const [step, setStep] = useState<'name-topic' | 'templates'>('name-topic');
  const [selectedIds, setSelectedIds] = useState<number[]>(() => {
    if (mode === 'edit-cast' && room?.template_names) {
      // Map template names back to IDs
      return templates
        .filter((t) => room.template_names!.includes(t.name))
        .map((t) => t.id);
    }
    return [];
  });

  const toggleId = (id: number) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const submitCreate = async (templateIds: number[]) => {
    setSaving(true);
    try {
      await post('/rooms', {
        name: name.trim(),
        topic: topic.trim() || undefined,
        templateIds,
      });
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleNameTopicNext = () => {
    const err = validateRoomName(name);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    if (templates.length > 0) {
      setStep('templates');
    } else {
      void submitCreate([]);
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

  const handleEditTopic = async () => {
    if (!room) return;
    setSaving(true);
    try {
      await patch(`/rooms/${encodeURIComponent(room.name)}`, {
        topic: topic.trim() || null,
      });
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleEditCast = async () => {
    if (!room) return;
    setSaving(true);
    try {
      await patch(`/rooms/${encodeURIComponent(room.name)}/templates`, {
        templateIds: selectedIds,
      });
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 rounded p-6 w-96 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'create' && step === 'name-topic' && (
          <>
            <h2 className="text-slate-100 font-semibold">Create Room</h2>
            <div className="space-y-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNameTopicNext()}
                placeholder="Room name"
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              />
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNameTopicNext()}
                placeholder="Topic (optional)"
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              />
            </div>
          </>
        )}

        {mode === 'create' && step === 'templates' && (
          <>
            <h2 className="text-slate-100 font-semibold">
              Add templates to #{name}
            </h2>
            <p className="text-xs text-slate-400">
              Select agent templates for this room (optional)
            </p>
            <ul className="max-h-48 overflow-y-auto space-y-1">
              {templates.map((t) => (
                <li key={t.id}>
                  <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700 cursor-pointer text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(t.id)}
                      onChange={() => toggleId(t.id)}
                      className="accent-blue-500"
                    />
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-slate-500">({t.role})</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        {mode === 'delete-confirm' && (
          <>
            <h2 className="text-slate-100 font-semibold">
              Delete #{room?.name}?
            </h2>
            <p className="text-sm text-slate-400">
              This will remove {room?.member_count ?? 0} member
              {(room?.member_count ?? 0) !== 1 ? 's' : ''} and all messages.
            </p>
          </>
        )}

        {mode === 'edit-topic' && room && (
          <>
            <h2 className="text-slate-100 font-semibold">
              Edit topic — #{room.name}
            </h2>
            <textarea
              autoFocus
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              placeholder="Room topic (optional)"
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none resize-none"
            />
          </>
        )}

        {mode === 'edit-cast' && room && (
          <>
            <h2 className="text-slate-100 font-semibold">
              Edit cast — #{room.name}
            </h2>
            <p className="text-xs text-slate-400">
              Select agent templates for this room
            </p>
            {templates.length === 0 ? (
              <p className="text-xs text-slate-500">
                No templates available. Create templates first.
              </p>
            ) : (
              <ul className="max-h-48 overflow-y-auto space-y-1">
                {templates.map((t) => (
                  <li key={t.id}>
                    <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700 cursor-pointer text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(t.id)}
                        onChange={() => toggleId(t.id)}
                        className="accent-blue-500"
                      />
                      <span className="font-medium">{t.name}</span>
                      <span className="text-xs text-slate-500">({t.role})</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>

          {mode === 'create' && step === 'name-topic' && (
            <button
              onClick={handleNameTopicNext}
              disabled={saving}
              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white"
            >
              {templates.length > 0 ? 'Next →' : saving ? '…' : 'Create'}
            </button>
          )}

          {mode === 'create' && step === 'templates' && (
            <>
              <button
                onClick={() => void submitCreate([])}
                className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200"
              >
                Skip
              </button>
              <button
                onClick={() => void submitCreate(selectedIds)}
                disabled={saving}
                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white"
              >
                {saving ? '…' : 'Create room'}
              </button>
            </>
          )}

          {mode === 'delete-confirm' && (
            <button
              onClick={() => void handleDelete()}
              disabled={saving}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 rounded text-sm text-white"
            >
              {saving ? '…' : 'Delete'}
            </button>
          )}

          {mode === 'edit-topic' && (
            <button
              onClick={() => void handleEditTopic()}
              disabled={saving}
              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white"
            >
              {saving ? '…' : 'Save'}
            </button>
          )}

          {mode === 'edit-cast' && (
            <button
              onClick={() => void handleEditCast()}
              disabled={saving}
              className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white"
            >
              {saving ? '…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
