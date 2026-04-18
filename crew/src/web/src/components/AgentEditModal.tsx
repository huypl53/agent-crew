import React, { useState } from 'react';
import { del, post } from '../hooks/useApi.ts';
import { validateCapabilities } from '../lib/validators.ts';
import type { Agent } from '../types.ts';

export { validateCapabilities };

interface Props {
  agent: Agent;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AgentEditModal({ agent, onClose, onSuccess }: Props) {
  const [persona, setPersona] = useState(agent.persona ?? '');
  const [capabilities, setCapabilities] = useState(
    agent.capabilities
      ? typeof agent.capabilities === 'string'
        ? agent.capabilities
        : JSON.stringify(agent.capabilities, null, 2)
      : '',
  );
  const [capError, setCapError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    const err = validateCapabilities(capabilities);
    if (err) {
      setCapError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await post(`/agents/${encodeURIComponent(agent.name)}/update`, {
        persona: persona || undefined,
        capabilities: capabilities.trim()
          ? JSON.parse(capabilities)
          : undefined,
      });
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await del(`/agents/${encodeURIComponent(agent.name)}?confirm=true`);
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setDeleting(false);
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
        <h2 className="text-slate-100 font-semibold">Edit {agent.name}</h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Persona
            </label>
            <textarea
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={3}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest">
              Capabilities <span className="normal-case">(JSON)</span>
            </label>
            <textarea
              value={capabilities}
              onChange={(e) => {
                setCapabilities(e.target.value);
                setCapError(null);
              }}
              rows={3}
              placeholder='["coding", "testing"]'
              className={`mt-1 w-full bg-slate-700 border rounded px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none ${capError ? 'border-red-500' : 'border-slate-600'}`}
            />
            {capError && (
              <div className="text-xs text-red-400 mt-1">{capError}</div>
            )}
          </div>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex gap-2 items-center">
          {confirmDelete ? (
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 rounded text-sm text-white"
            >
              {deleting ? '…' : 'Confirm delete'}
            </button>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300"
            >
              Delete
            </button>
          )}
          <div className="flex-1" />
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
            {saving ? '…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
