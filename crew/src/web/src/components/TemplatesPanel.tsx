import React, { useEffect, useState } from 'react';
import { get, del } from '../hooks/useApi.ts';
import { useWebSocket } from '../hooks/useWebSocket.ts';
import type { AgentTemplate, RoomTemplate } from '../types.ts';
import TemplateModal from './TemplateModal.tsx';
import RoomTemplateModal from './RoomTemplateModal.tsx';

export default function TemplatesPanel() {
  const [subTab, setSubTab] = useState<'agent' | 'room'>('agent');
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [roomTemplates, setRoomTemplates] = useState<RoomTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<AgentTemplate | 'create' | null>(null);
  const [roomTplModal, setRoomTplModal] = useState<RoomTemplate | 'create' | null>(null);

  const loadAgentTemplates = () => get<AgentTemplate[]>('/templates')
    .then(setTemplates)
    .catch(e => setError((e as Error).message));

  const loadRoomTemplates = () => get<RoomTemplate[]>('/room-templates')
    .then(setRoomTemplates)
    .catch(e => setError((e as Error).message));

  useEffect(() => { void loadAgentTemplates(); void loadRoomTemplates(); }, []);

  const { subscribe } = useWebSocket();
  useEffect(() => subscribe('template-change', () => void loadAgentTemplates()), [subscribe]);
  useEffect(() => subscribe('room-template-change', () => void loadRoomTemplates()), [subscribe]);

  const handleDeleteAgent = async (t: AgentTemplate) => {
    if (!confirm(`Delete agent template "${t.name}"?`)) return;
    try { await del(`/templates/${t.id}`); void loadAgentTemplates(); }
    catch (e) { setError((e as Error).message); }
  };

  const handleDeleteRoom = async (rt: RoomTemplate) => {
    if (!confirm(`Delete room template "${rt.name}"?`)) return;
    try { await del(`/room-templates/${rt.id}`); void loadRoomTemplates(); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto bg-slate-900">
      <h2 className="text-slate-200 font-semibold mb-3">Templates</h2>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-4 border-b border-slate-700">
        <button
          onClick={() => setSubTab('agent')}
          className={`px-3 py-1.5 text-sm -mb-px ${subTab === 'agent' ? 'border-b-2 border-blue-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Agent Templates
        </button>
        <button
          onClick={() => setSubTab('room')}
          className={`px-3 py-1.5 text-sm -mb-px ${subTab === 'room' ? 'border-b-2 border-blue-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Room Templates
        </button>
      </div>

      {error && <div className="text-xs text-red-400 mb-3">{error}</div>}

      {/* Agent Templates section */}
      {subTab === 'agent' && (
        <>
          <div className="flex items-center mb-3">
            <span className="text-slate-400 text-xs flex-1">{templates.length} agent template(s)</span>
            <button onClick={() => setModal('create')} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white">
              + New
            </button>
          </div>
          <div className="space-y-2">
            {templates.map(t => (
              <div key={t.id} className="bg-slate-800 rounded-lg p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-slate-200 font-medium text-sm">{t.name}</span>
                    <span className="text-xs bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded">{t.role}</span>
                  </div>
                  {t.persona && <p className="text-xs text-slate-400 truncate">{t.persona}</p>}
                  {t.capabilities && <p className="text-xs text-slate-500 truncate mt-0.5">{t.capabilities}</p>}
                </div>
                <button onClick={() => setModal(t)} className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1">Edit</button>
                <button onClick={() => void handleDeleteAgent(t)} className="text-xs text-slate-500 hover:text-red-400 px-2 py-1">Delete</button>
              </div>
            ))}
            {templates.length === 0 && <p className="text-slate-500 text-sm">No agent templates yet.</p>}
          </div>
        </>
      )}

      {/* Room Templates section */}
      {subTab === 'room' && (
        <>
          <div className="flex items-center mb-3">
            <span className="text-slate-400 text-xs flex-1">{roomTemplates.length} room template(s)</span>
            <button onClick={() => setRoomTplModal('create')} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white">
              + New
            </button>
          </div>
          <div className="space-y-2">
            {roomTemplates.map(rt => (
              <div key={rt.id} className="bg-slate-800 rounded-lg p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-slate-200 font-medium text-sm">{rt.name}</span>
                  {rt.topic && <p className="text-xs text-slate-400 truncate">{rt.topic}</p>}
                  <p className="text-xs text-slate-500">{rt.agent_template_ids.length} agent(s)</p>
                </div>
                <button onClick={() => setRoomTplModal(rt)} className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1">Edit</button>
                <button onClick={() => void handleDeleteRoom(rt)} className="text-xs text-slate-500 hover:text-red-400 px-2 py-1">Delete</button>
              </div>
            ))}
            {roomTemplates.length === 0 && <p className="text-slate-500 text-sm">No room templates yet.</p>}
          </div>
        </>
      )}

      {/* Modals */}
      {modal !== null && (
        <TemplateModal
          template={modal === 'create' ? null : modal}
          onClose={() => setModal(null)}
          onSuccess={() => { setModal(null); void loadAgentTemplates(); }}
        />
      )}
      {roomTplModal !== null && (
        <RoomTemplateModal
          template={roomTplModal === 'create' ? null : roomTplModal}
          agentTemplates={templates}
          onClose={() => setRoomTplModal(null)}
          onSuccess={() => { setRoomTplModal(null); void loadRoomTemplates(); }}
        />
      )}
    </div>
  );
}
