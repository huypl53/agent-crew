import React, { useEffect, useState } from 'react';
import AgentEditModal from './components/AgentEditModal.tsx';
import AgentInspector from './components/AgentInspector.tsx';
import Composer from './components/Composer.tsx';
import HeaderStats from './components/HeaderStats.tsx';
import KindFilter from './components/KindFilter.tsx';
import MessageFeed from './components/MessageFeed.tsx';
import type { View } from './components/NavBar.tsx';
import NavBar from './components/NavBar.tsx';
import RoomModal from './components/RoomModal.tsx';
import RoomsSidebar from './components/RoomsSidebar.tsx';
import TaskBoard from './components/TaskBoard.tsx';
import TemplatesPanel from './components/TemplatesPanel.tsx';
import TimelineView from './components/TimelineView.tsx';
import TraceView from './components/TraceView.tsx';
import { get, post } from './hooks/useApi.ts';
import { useMessages } from './hooks/useMessages.ts';
import { useWebSocket } from './hooks/useWebSocket.ts';
import type { Agent, AgentTemplate, Message, Room } from './types.ts';

const ALL_KINDS = ['task', 'completion', 'error', 'question', 'status', 'chat'];

type RoomModalState =
  | { mode: 'create' }
  | { mode: 'delete-confirm'; room: Room }
  | { mode: 'edit-topic'; room: Room }
  | { mode: 'edit-cast'; room: Room };

export default function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  const { messages, loading, error } = useMessages(selectedRoom, subscribe);

  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [roomModal, setRoomModal] = useState<RoomModalState | null>(null);
  const [agentEditTarget, setAgentEditTarget] = useState<Agent | null>(null);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(
    new Set(ALL_KINDS),
  );
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);

  // Fetch templates on mount and refresh on template-change WS event
  useEffect(() => {
    get<AgentTemplate[]>('/templates')
      .then(setTemplates)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    return subscribe('template-change', () => {
      get<AgentTemplate[]>('/templates')
        .then(setTemplates)
        .catch(() => undefined);
    });
  }, [subscribe]);

  const toggleKind = (kind: string) => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      return next;
    });
  };

  const handleCloneRoom = async (room: Room) => {
    const templateName = prompt(
      `Save room "${room.name}" as template. Enter template name:`,
    );
    if (!templateName?.trim()) return;
    try {
      await post('/room-templates', {
        name: templateName.trim(),
        topic: room.topic ?? null,
        agentTemplateIds: [],
      });
    } catch (e) {
      alert(`Failed to clone: ${(e as Error).message}`);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100 overflow-hidden">
      <NavBar currentView={currentView} onViewChange={setCurrentView} />
      <HeaderStats />

      {currentView === 'dashboard' && (
        <div className="flex flex-1 min-h-0">
          <RoomsSidebar
            selectedRoom={selectedRoom}
            onSelect={setSelectedRoom}
            onCreateRoom={() => setRoomModal({ mode: 'create' })}
            onDeleteRoom={(room) =>
              setRoomModal({ mode: 'delete-confirm', room })
            }
            onEditTopic={(room) => setRoomModal({ mode: 'edit-topic', room })}
            onEditCast={(room) => setRoomModal({ mode: 'edit-cast', room })}
            onCloneRoom={(room) => void handleCloneRoom(room)}
          />
          <main className="flex-1 flex flex-col min-w-0">
            <header className="px-4 py-2 border-b border-slate-700 text-sm text-slate-400 flex-shrink-0">
              {selectedRoom ? (
                <span className="text-slate-200 font-medium">
                  #{selectedRoom}
                </span>
              ) : (
                'Crew Dashboard'
              )}
            </header>
            <KindFilter enabledKinds={enabledKinds} onToggle={toggleKind} />
            <MessageFeed
              messages={messages}
              enabledKinds={enabledKinds}
              loading={loading}
              error={error}
              room={selectedRoom}
              onReplySelect={setReplyTarget}
            />
            <div className="border-t border-slate-700 flex-shrink-0">
              <Composer
                room={selectedRoom}
                replyTarget={replyTarget}
                onClearReply={() => setReplyTarget(null)}
              />
            </div>
          </main>
          <AgentInspector
            room={selectedRoom}
            onEditAgent={setAgentEditTarget}
          />
        </div>
      )}

      {currentView === 'tasks' && (
        <div className="flex-1 flex overflow-hidden">
          <TaskBoard />
        </div>
      )}

      {currentView === 'timeline' && (
        <div className="flex-1 flex overflow-hidden">
          <TimelineView />
        </div>
      )}

      {currentView === 'trace' && (
        <div className="flex-1 flex overflow-hidden">
          <TraceView />
        </div>
      )}

      {currentView === 'templates' && (
        <div className="flex-1 flex overflow-hidden">
          <TemplatesPanel />
        </div>
      )}

      {roomModal && (
        <RoomModal
          mode={roomModal.mode}
          room={'room' in roomModal ? roomModal.room : undefined}
          templates={templates}
          onClose={() => setRoomModal(null)}
          onSuccess={() => setRoomModal(null)}
        />
      )}
      {agentEditTarget && (
        <AgentEditModal
          agent={agentEditTarget}
          onClose={() => setAgentEditTarget(null)}
          onSuccess={() => setAgentEditTarget(null)}
        />
      )}
    </div>
  );
}
