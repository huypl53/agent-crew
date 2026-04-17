import React, { useState } from 'react';
import type { RoomTemplate, AgentTemplate } from '../types.ts';
import { post, patch } from '../hooks/useApi.ts';

interface Props {
  template: RoomTemplate | null;
  agentTemplates: AgentTemplate[];
  onClose: () => void;
  onSuccess: () => void;
}

export default function RoomTemplateModal({ template, agentTemplates, onClose, onSuccess }: Props) {
  const [name, setName] = useState(template?.name ?? '');
  const [topic, setTopic] = useState(template?.topic ?? '');
  const [selectedIds, setSelectedIds] = useState<number[]>(template?.agent_template_ids ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const toggleId = (id: number) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), topic: topic.trim() || null, agent_template_ids: selectedIds };
      if (template) {
        await patch(`/room-templates/${template.id}`, body);
      } else {
        await post('/room-templates', { ...body, agentTemplateIds: selectedIds });
      }
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-slate-800 rounded-lg p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-slate-100 font-semibold">{template ? 'Edit Room Template' : 'New Room Template'}</h2>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              placeholder="my-room-template"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">Topic</label>
            <input
              value={topic}
              onChange={e => setTopic(e.target.value)}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              placeholder="Optional room topic"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">Agent Templates</label>
            {agentTemplates.length === 0 ? (
              <p className="text-xs text-slate-500 mt-1">No agent templates available</p>
            ) : (
              <ul className="mt-1 max-h-40 overflow-y-auto space-y-1">
                {agentTemplates.map(at => (
                  <li key={at.id}>
                    <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700 cursor-pointer text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(at.id)}
                        onChange={() => toggleId(at.id)}
                        className="accent-blue-500"
                      />
                      <span className="font-medium">{at.name}</span>
                      <span className="text-xs text-slate-500">({at.role})</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white"
          >
            {saving ? '…' : template ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
