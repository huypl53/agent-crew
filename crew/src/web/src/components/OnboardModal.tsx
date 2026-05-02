import React, { useRef, useState } from 'react';
import { useFocusTrap } from './a11y-utils.ts';
import { post } from '../hooks/useApi.ts';
import type { AgentTemplate, RoomTemplate } from '../types.ts';

interface Props {
  template: RoomTemplate;
  agentTemplates: AgentTemplate[];
  onClose: () => void;
}

interface OnboardResult {
  name: string;
  role: string;
  pane: string;
  status: string;
}

export default function OnboardModal({
  template,
  agentTemplates,
  onClose,
}: Props) {
  const [roomName, setRoomName] = useState(template.name);
  const [path, setPath] = useState('');
  const [step, setStep] = useState<'input' | 'review' | 'result'>('input');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<OnboardResult[]>([]);

  const resolvedAgents = template.agent_template_ids
    .map((id) => agentTemplates.find((at) => at.id === id))
    .filter(Boolean) as AgentTemplate[];

  const handleReview = () => {
    if (!roomName.trim()) {
      setError('Room name is required');
      return;
    }
    if (!path.trim()) {
      setError('Project path is required');
      return;
    }
    setError(null);
    setStep('review');
  };

  const handleOnboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await post<{
        ok: boolean;
        room: string;
        agents: OnboardResult[];
      }>(`/room-templates/${template.id}/onboard`, {
        name: roomName.trim(),
        path: path.trim(),
      });
      setResults(res.agents);
      setStep('result');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Onboard: ${template.name}`}
        className="bg-white dark:bg-slate-800 rounded-lg p-6 w-[420px] space-y-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-slate-700 dark:text-slate-100 font-semibold">
          Onboard: {template.name}
        </h2>

        {step === 'input' && (
          <>
            <div>
              <label className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                Room Name
              </label>
              <input
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                className="mt-1 w-full bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded px-3 py-2 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-white dark:focus:ring-offset-slate-800"
                placeholder="my-room"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                Project Path
              </label>
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-slate-800"
                placeholder="/path/to/project"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Local filesystem path for the new room
              </p>
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
                onClick={handleReview}
                className="px-3 py-1.5 bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500 rounded text-sm text-slate-700 dark:text-white"
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === 'review' && (
          <>
            <div className="space-y-2">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <span className="uppercase tracking-widest">Room</span>
                <p className="text-slate-600 dark:text-slate-300 mt-0.5">{roomName}</p>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <span className="uppercase tracking-widest">Path</span>
                <p className="font-mono text-slate-600 dark:text-slate-300 mt-0.5">{path}</p>
              </div>
              {template.topic && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="uppercase tracking-widest">Topic</span>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5">{template.topic}</p>
                </div>
              )}
              <div>
                <span className="text-xs text-slate-400 uppercase tracking-widest">
                  Agents ({resolvedAgents.length})
                </span>
                <ul className="mt-1 space-y-1">
                  {resolvedAgents.map((at) => (
                    <li
                      key={at.id}
                      className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-2"
                    >
                      <span className="font-medium">{at.name}</span>
                      <span className="text-xs bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded">
                        {at.role}
                      </span>
                      <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                        $ {at.start_command || 'claude'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setStep('input')}
                className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200"
              >
                Back
              </button>
              <button
                onClick={() => void handleOnboard()}
                disabled={loading}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm text-white"
              >
                {loading ? 'Onboarding...' : 'Onboard'}
              </button>
            </div>
          </>
        )}

        {step === 'result' && (
          <>
            <div className="space-y-2">
              <p className="text-sm text-green-400">Room onboarded.</p>
              <ul className="space-y-1">
                {results.map((r) => (
                  <li
                    key={r.pane}
                    className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-2"
                  >
                    <span className="font-medium">{r.name}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${r.status === 'started' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}
                    >
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-3 py-1.5 bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500 rounded text-sm text-slate-700 dark:text-white"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
