import React, { useState } from 'react';
import RoomsSidebar from './components/RoomsSidebar.tsx';
import MessageFeed from './components/MessageFeed.tsx';
import AgentInspector from './components/AgentInspector.tsx';
import Composer from './components/Composer.tsx';
import RoomModal from './components/RoomModal.tsx';
import AgentEditModal from './components/AgentEditModal.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { useMessages } from './hooks/useMessages.ts';

export default function App() {
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  const { messages, loading, error } = useMessages(selectedRoom, subscribe);

  return (
    <div className="h-screen flex bg-slate-900 text-slate-100 overflow-hidden">
      <RoomsSidebar selectedRoom={selectedRoom} onSelect={setSelectedRoom} />
      <main className="flex-1 flex flex-col min-w-0">
        <header className="px-4 py-2 border-b border-slate-700 text-sm text-slate-400 flex-shrink-0">
          {selectedRoom ? <span className="text-slate-200 font-medium">#{selectedRoom}</span> : 'Crew Dashboard'}
        </header>
        <MessageFeed messages={messages} loading={loading} error={error} room={selectedRoom} />
        <div className="border-t border-slate-700 flex-shrink-0">
          <Composer />
        </div>
      </main>
      <AgentInspector room={selectedRoom} />
      <RoomModal />
      <AgentEditModal />
    </div>
  );
}
