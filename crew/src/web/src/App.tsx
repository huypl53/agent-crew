import React, { useState } from 'react';
import RoomsSidebar from './components/RoomsSidebar.tsx';
import MessageFeed from './components/MessageFeed.tsx';
import AgentInspector from './components/AgentInspector.tsx';
import Composer from './components/Composer.tsx';
import RoomModal from './components/RoomModal.tsx';
import AgentEditModal from './components/AgentEditModal.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { useMessages } from './hooks/useMessages.ts';
import type { Agent, Message, Room } from './types.ts';

type RoomModalState = { mode: 'create' } | { mode: 'delete-confirm'; room: Room };

export default function App() {
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  const { messages, loading, error } = useMessages(selectedRoom, subscribe);

  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [roomModal, setRoomModal] = useState<RoomModalState | null>(null);
  const [agentEditTarget, setAgentEditTarget] = useState<Agent | null>(null);

  return (
    <div className="h-screen flex bg-slate-900 text-slate-100 overflow-hidden">
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
        <MessageFeed
          messages={messages}
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
    </div>
  );
}
