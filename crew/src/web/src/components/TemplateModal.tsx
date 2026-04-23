import React, { useState } from 'react';
import { patch, post } from '../hooks/useApi.ts';
import type { AgentTemplate } from '../types.ts';

interface Props {
  template: AgentTemplate | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TemplateModal({ template, onClose, onSuccess }: Props) {
  const [name, setName] = useState(template?.name ?? '');
  const [role, setRole] = useState<AgentTemplate['role']>(
    template?.role ?? 'worker',
  );
  const [persona, setPersona] = useState(template?.persona ?? '');
  const [capabilities, setCapabilities] = useState(
    template?.capabilities ?? '',
  );
  const [startCommand, setStartCommand] = useState(
    template?.start_command ?? 'claude',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        role,
        persona: persona || undefined,
        capabilities: capabilities || undefined,
        start_command: startCommand || 'claude',
      };
      if (template) {
        await patch(`/templates/${template.id}`, body);
      } else {
        await post('/templates', body);
      }
      onSuccess();
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
        className="bg-slate-800 rounded-lg p-6 w-96 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-slate-100 font-semibold">
          {template ? 'Edit Template' : 'New Template'}
        </h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
              placeholder="my-template"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as AgentTemplate['role'])}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none"
            >
              <option value="worker">worker</option>
              <option value="leader">leader</option>
              <option value="boss">boss</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Persona
            </label>
            <textarea
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={3}
              placeholder="You are a senior engineer..."
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Capabilities
            </label>
            <textarea
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              rows={2}
              placeholder='["coding", "testing"]'
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Start Command
            </label>
            <input
              value={startCommand}
              onChange={(e) => setStartCommand(e.target.value)}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none font-mono"
              placeholder="claude"
            />
            <p className="text-xs text-slate-500 mt-1">
              Command to launch the agent (default: claude)
            </p>
          </div>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200"
          >
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
