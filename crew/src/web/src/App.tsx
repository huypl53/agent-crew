import React, { useEffect, useState } from 'react';
import RoomsSidebar from './components/RoomsSidebar.tsx';
import MessageFeed from './components/MessageFeed.tsx';
import KindFilter from './components/KindFilter.tsx';
import AgentInspector from './components/AgentInspector.tsx';
import HeaderStats from './components/HeaderStats.tsx';
import NavBar from './components/NavBar.tsx';
import TaskBoard from './components/TaskBoard.tsx';
import TimelineView from './components/TimelineView.tsx';
import Composer from './components/Composer.tsx';
import RoomModal from './components/RoomModal.tsx';
import AgentEditModal from './components/AgentEditModal.tsx';
import KeyboardShortcuts from './components/KeyboardShortcuts.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { useMessages } from './hooks/useMessages.ts';
import type { Agent, Message, Room } from './types.ts';
import type { View } from './components/NavBar.tsx';

const ALL_KINDS = ['task', 'completion', 'error', 'question', 'status', 'chat'];

type RoomModalState = { mode: 'create' } | { mode: 'delete-confirm'; room: Room };

export default function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  const { messages, loading, error } = useMessages(selectedRoom, subscribe);

  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [roomModal, setRoomModal] = useState<RoomModalState | null>(null);
  const [agentEditTarget, setAgentEditTarget] = useState<Agent | null>(null);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(new Set(ALL_KINDS));
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);

  const toggleKind = (kind: string) => {
    setEnabledKinds(prev => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      return next;
    });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShowKeyboardShortcuts(true);
      }
      if (e.key === 'Escape' && showKeyboardShortcuts) {
        setShowKeyboardShortcuts(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showKeyboardShortcuts]);

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
            onDeleteRoom={room => setRoomModal({ mode: 'delete-confirm', room })}
          />
          <main className="flex-1 flex flex-col min-w-0">
            <header className="px-4 py-2 border-b border-slate-700 text-sm text-slate-400 flex-shrink-0">
              {selectedRoom ? <span className="text-slate-200 font-medium">#{selectedRoom}</span> : 'Crew Dashboard'}
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
              <Composer room={selectedRoom} replyTarget={replyTarget} onClearReply={() => setReplyTarget(null)} />
            </div>
          </main>
          <AgentInspector room={selectedRoom} onEditAgent={setAgentEditTarget} />
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
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-700 text-sm text-slate-400 flex-shrink-0">
            Crew
          </div>
          <div className="text-xs text-slate-500 px-4 py-1 italic">
            Trace view coming soon (Phase 02)
          </div>
        </div>
      )}

      {roomModal && (
        <RoomModal
          mode={roomModal.mode}
          room={roomModal.mode === 'delete-confirm' ? roomModal.room : undefined}
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
      {showKeyboardShortcuts && (
        <KeyboardShortcuts onClose={() => setShowKeyboardShortcuts(false)} />
      )}
    </div>
  );
}
