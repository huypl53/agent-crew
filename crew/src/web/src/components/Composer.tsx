import type React from 'react';
import { useEffect, useState } from 'react';
import { get, post } from '../hooks/useApi.ts';
import { buildMessagePayload } from '../lib/compose.ts';
import type { Agent, Message } from '../types.ts';

export { buildMessagePayload };

interface Props {
  room: string | null;
  replyTarget: Message | null;
  onClearReply: () => void;
}

const KINDS = [
  'chat',
  'task',
  'completion',
  'error',
  'question',
  'status',
] as const;

export default function Composer({ room, replyTarget, onClearReply }: Props) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('chat');
  const [mode, setMode] = useState<'push' | 'pull'>('push');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!room) {
      setAgents([]);
      return;
    }
    get<Agent[]>(`/rooms/${encodeURIComponent(room)}/members`)
      .then(setAgents)
      .catch(() => undefined);
  }, [room]);

  const send = async () => {
    if (!room || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await post(
        '/messages',
        buildMessagePayload(room, text, to, kind, mode, replyTarget),
      );
      setText('');
      onClearReply();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };

  const disabled = !room;

  return (
    <div className={`p-2 space-y-1 ${disabled ? 'opacity-50' : ''}`}>
      {replyTarget && (
        <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-700/50 rounded px-2 py-1">
          <span className="truncate">
            Replying to #{replyTarget.message_id}:{' '}
            {replyTarget.text.slice(0, 60)}
            {replyTarget.text.length > 60 ? '…' : ''}
          </span>
          <button
            onClick={onClearReply}
            className="ml-auto flex-shrink-0 text-slate-500 hover:text-slate-300"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={disabled}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
        >
          <option value="">broadcast</option>
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={disabled}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          onClick={() => setMode((m) => (m === 'push' ? 'pull' : 'push'))}
          disabled={disabled}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
        >
          {mode}
        </button>
      </div>
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={room ? 'Message… (⌘↵ to send)' : 'Select a room'}
          rows={2}
          className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 resize-none focus:outline-none focus:border-slate-500 placeholder-slate-500"
        />
        <button
          onClick={() => void send()}
          disabled={disabled || sending || !text.trim()}
          className="px-3 py-1 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded text-sm text-white self-end"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}
