import type React from 'react';
import { useEffect, useState } from 'react';
import { get, post } from '../hooks/useApi.ts';
import type {
  Agent,
  AgentTemplate,
  Room,
  TmuxWindowInfo,
  TmuxWindowsResponse,
} from '../types.ts';

const STATUS_COLORS: Record<string, string> = {
  busy: 'text-yellow-400',
  idle: 'text-green-400',
  dead: 'text-red-400',
  unknown: 'text-slate-500',
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-slate-500 uppercase tracking-widest text-[10px] mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-400 py-1 border-t border-slate-700 mt-1"
    >
      <span>{label}</span>
      <span>{open ? '▾' : '▸'}</span>
    </button>
  );
}

function activeFor(joinedAt: string): string {
  const ms = Date.now() - new Date(joinedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function renderWindowPreview(window: TmuxWindowInfo): string {
  if (window.panes.length === 0) return '[empty]';
  return window.panes
    .map(
      (pane) =>
        `${pane.active ? '●' : '○'}${pane.pane_index}:${pane.title || pane.pane_id}`,
    )
    .join(' | ');
}

interface Props {
  room: string | null;
  templates: AgentTemplate[];
  onEditAgent?: (agent: Agent) => void;
}

export default function AgentInspector({
  room,
  templates,
  onEditAgent,
}: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roomInfo, setRoomInfo] = useState<Room | null>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(true);
  const [costOpen, setCostOpen] = useState(true);
  const [sendTarget, setSendTarget] = useState<string | null>(null);
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [tmuxWindows, setTmuxWindows] = useState<TmuxWindowsResponse | null>(
    null,
  );
  const [onboardTemplateId, setOnboardTemplateId] = useState<number | ''>('');
  const [onboardName, setOnboardName] = useState('');
  const [onboardWindow, setOnboardWindow] = useState<number | null>(null);
  const [onboardLoading, setOnboardLoading] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);

  // Reset send state when selected agent changes
  useEffect(() => {
    setSendTarget(null);
    setSendText('');
    setSendError(null);
  }, [selected?.name]);

  const handleSendInput = async () => {
    if (!selected || !sendText.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await post(`/agents/${encodeURIComponent(selected.name)}/send-input`, {
        text: sendText,
      });
      setSendText('');
      setSendTarget(null);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const openOnboardModal = async () => {
    if (!room) return;
    setOnboardOpen(true);
    setOnboardError(null);
    setOnboardLoading(true);
    try {
      const data = await get<TmuxWindowsResponse>(
        `/rooms/${encodeURIComponent(room)}/tmux-windows`,
      );
      setTmuxWindows(data);
      setOnboardWindow(data.active_window_index);
      if (templates.length > 0) setOnboardTemplateId(templates[0]!.id);
    } catch (e) {
      setOnboardError((e as Error).message);
      setTmuxWindows(null);
      setOnboardWindow(null);
    } finally {
      setOnboardLoading(false);
    }
  };

  const handleOnboard = async () => {
    if (!room || onboardTemplateId === '' || onboardWindow === null) return;
    setOnboardLoading(true);
    setOnboardError(null);
    try {
      await post(`/rooms/${encodeURIComponent(room)}/onboard-agent`, {
        templateId: onboardTemplateId,
        name: onboardName.trim() || undefined,
        windowIndex: onboardWindow,
      });
      const members = await get<Agent[]>(
        `/rooms/${encodeURIComponent(room)}/members`,
      );
      setAgents(members);
      setOnboardOpen(false);
      setOnboardName('');
    } catch (e) {
      setOnboardError((e as Error).message);
    } finally {
      setOnboardLoading(false);
    }
  };

  useEffect(() => {
    setSelected(null);
    setRoomInfo(null);
    if (!room) {
      setAgents([]);
      return;
    }
    // Fetch room info (includes template_names)
    get<Room>(`/rooms/${encodeURIComponent(room)}`)
      .then(setRoomInfo)
      .catch(() => undefined);
    // Fetch members
    get<Agent[]>(`/rooms/${encodeURIComponent(room)}/members`)
      .then(setAgents)
      .catch((e) => setError((e as Error).message));
    const id = setInterval(() => {
      if (!room) return;
      get<Agent[]>(`/rooms/${encodeURIComponent(room)}/members`)
        .then(setAgents)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [room]);

  const selectAgent = async (name: string) => {
    try {
      const agent = await get<Agent>(`/agents/${encodeURIComponent(name)}`);
      setSelected(agent);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tu = selected?.token_usage;
  const ms = selected?.message_stats;
  const ts = selected?.task_stats;
  const hasCost = tu != null;
  const hasStats = ms != null || ts != null || selected?.joined_at != null;

  return (
    <aside className="w-64 flex-shrink-0 bg-slate-800 border-l border-slate-700 flex flex-col">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400 border-b border-slate-700 flex items-center gap-2">
        <span className="flex-1">Agents {room ? `· #${room}` : ''}</span>
        {room && (
          <button
            onClick={() => void openOnboardModal()}
            className="px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-[10px] text-slate-200"
            title="Onboard agent from template"
          >
            + Agent
          </button>
        )}
      </div>
      {error && <div className="p-2 text-xs text-red-400">{error}</div>}
      <ul className="border-b border-slate-700 overflow-y-auto max-h-48">
        {agents.map((a) => (
          <li key={a.name}>
            <button
              onClick={() => selectAgent(a.name)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-700 transition-colors ${selected?.name === a.name ? 'bg-slate-700' : ''}`}
            >
              <span
                className={`text-xs mr-1 ${STATUS_COLORS[a.status] ?? 'text-slate-500'}`}
              >
                ●
              </span>
              <span className="text-slate-200">{a.name}</span>
              <span className="ml-1 text-xs text-slate-500">{a.role}</span>
            </button>
          </li>
        ))}
        {agents.length === 0 && !error && !roomInfo?.template_names?.length && (
          <li className="px-3 py-2 text-xs text-slate-500">No agents</li>
        )}
        {agents.length === 0 &&
          !error &&
          !!roomInfo?.template_names?.length && (
            <>
              <li className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500 bg-slate-700/30">
                Expected cast
              </li>
              {roomInfo.template_names.map((name) => (
                <li
                  key={name}
                  className="px-3 py-1.5 text-sm text-slate-500 italic"
                >
                  <span className="text-xs mr-1 text-slate-600">○</span>
                  {name}
                  <span className="ml-1 text-[10px] text-slate-600">
                    · not joined
                  </span>
                </li>
              ))}
            </>
          )}
      </ul>

      {selected && (
        <div className="flex-1 overflow-y-auto p-3 text-xs space-y-2">
          <Field label="Name">
            <div className="text-slate-200 font-medium">{selected.name}</div>
          </Field>
          <Field label="Role / Status">
            <div className="flex gap-2">
              <span className="text-slate-300">{selected.role}</span>
              <span
                className={STATUS_COLORS[selected.status] ?? 'text-slate-500'}
              >
                {selected.status}
              </span>
            </div>
          </Field>
          {selected.tmux_target && (
            <Field label="Pane">
              <div className="text-slate-400 font-mono">
                {selected.tmux_target}
              </div>
            </Field>
          )}
          {selected.persona && (
            <Field label="Persona">
              <div className="text-slate-300">{selected.persona}</div>
            </Field>
          )}
          {selected.capabilities && (
            <Field label="Capabilities">
              <div className="text-slate-300">{selected.capabilities}</div>
            </Field>
          )}
          {selected.room_name && (
            <Field label="Room">
              <div className="text-slate-400">{selected.room_name}</div>
            </Field>
          )}

          {hasStats && (
            <>
              <SectionHeader
                label="Stats"
                open={statsOpen}
                onToggle={() => setStatsOpen((o) => !o)}
              />
              {statsOpen && (
                <div className="space-y-1.5 pl-1">
                  {selected.joined_at && (
                    <Field label="Active for">
                      <div className="text-slate-300">
                        {activeFor(selected.joined_at)}
                      </div>
                    </Field>
                  )}
                  {ts && (
                    <Field label="Tasks">
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-slate-300">
                        <span>
                          <span className="text-green-400">{ts.done}</span> done
                        </span>
                        <span>
                          <span className="text-blue-400">{ts.active}</span>{' '}
                          active
                        </span>
                        <span>
                          <span className="text-slate-400">{ts.queued}</span>{' '}
                          queued
                        </span>
                        {ts.error > 0 && (
                          <span>
                            <span className="text-red-400">{ts.error}</span> err
                          </span>
                        )}
                      </div>
                    </Field>
                  )}
                  {ms && (
                    <Field label="Messages">
                      <div className="flex gap-2 text-slate-300">
                        <span>
                          <span className="text-slate-200">{ms.sent}</span> sent
                        </span>
                        <span>
                          <span className="text-slate-200">{ms.received}</span>{' '}
                          rcvd
                        </span>
                      </div>
                    </Field>
                  )}
                </div>
              )}
            </>
          )}

          {hasCost && (
            <>
              <SectionHeader
                label="Cost"
                open={costOpen}
                onToggle={() => setCostOpen((o) => !o)}
              />
              {costOpen && (
                <div className="space-y-1.5 pl-1">
                  {tu!.model && (
                    <Field label="Model">
                      <div className="text-slate-300 font-mono text-[10px]">
                        {tu!.model}
                      </div>
                    </Field>
                  )}
                  <Field label="Tokens">
                    <div className="flex gap-2 text-slate-300">
                      <span>
                        <span className="text-slate-200">
                          {tu!.input_tokens.toLocaleString()}
                        </span>{' '}
                        in
                      </span>
                      <span>
                        <span className="text-slate-200">
                          {tu!.output_tokens.toLocaleString()}
                        </span>{' '}
                        out
                      </span>
                    </div>
                  </Field>
                  {tu!.cost_usd != null && (
                    <Field label="Cost USD">
                      <div className="text-amber-400 font-semibold">
                        ${tu!.cost_usd.toFixed(4)}
                      </div>
                    </Field>
                  )}
                </div>
              )}
            </>
          )}

          {onEditAgent && (
            <button
              onClick={() => onEditAgent(selected)}
              className="mt-2 px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-slate-300 w-full"
            >
              Edit
            </button>
          )}

          {selected.tmux_target && (
            <div className="mt-3 pt-3 border-t border-slate-700">
              {sendTarget === selected.name ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={sendText}
                    onChange={(e) => setSendText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                        void handleSendInput();
                      if (e.key === 'Escape') {
                        setSendTarget(null);
                        setSendText('');
                      }
                    }}
                    rows={3}
                    placeholder="Text to send to agent pane…"
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 resize-none focus:outline-none focus:border-slate-500"
                  />
                  {sendError && (
                    <p className="text-xs text-red-400">{sendError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleSendInput()}
                      disabled={sending || !sendText.trim()}
                      className="flex-1 px-2 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 rounded text-xs text-white"
                    >
                      {sending ? 'Sending…' : 'Send (⌘↵)'}
                    </button>
                    <button
                      onClick={() => {
                        setSendTarget(null);
                        setSendText('');
                        setSendError(null);
                      }}
                      className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200 rounded"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setSendTarget(selected.name)}
                  className="w-full px-2 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs text-slate-300 text-left"
                >
                  Send input to agent…
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {!selected && (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-xs">
          Click an agent to inspect
        </div>
      )}

      {onboardOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setOnboardOpen(false)}
        >
          <div
            className="bg-slate-800 rounded p-4 w-[30rem] max-h-[80vh] overflow-y-auto space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-slate-100">
              Onboard agent to #{room}
            </h3>

            <div>
              <label className="text-xs text-slate-400 uppercase tracking-widest">
                Template
              </label>
              <select
                value={onboardTemplateId}
                onChange={(e) => setOnboardTemplateId(Number(e.target.value))}
                className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.role})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 uppercase tracking-widest">
                Agent name (optional)
              </label>
              <input
                value={onboardName}
                onChange={(e) => setOnboardName(e.target.value)}
                placeholder="Default: template name"
                className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 uppercase tracking-widest">
                Target window
              </label>
              {onboardLoading && !tmuxWindows ? (
                <p className="mt-1 text-xs text-slate-500">Loading windows…</p>
              ) : (
                <div className="mt-1 space-y-2">
                  {tmuxWindows?.windows.map((window) => (
                    <button
                      key={window.index}
                      onClick={() => setOnboardWindow(window.index)}
                      className={`w-full text-left p-2 rounded border ${onboardWindow === window.index ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-900/40 hover:bg-slate-700/40'}`}
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-200 font-medium">
                          [{window.index}] {window.name || 'window'}
                        </span>
                        {window.active && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-900 text-emerald-300">
                            active
                          </span>
                        )}
                        <span className="text-slate-500">
                          {window.pane_count} panes
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400 font-mono break-words">
                        {renderWindowPreview(window)}
                      </div>
                    </button>
                  ))}
                  {!tmuxWindows?.windows.length && (
                    <p className="text-xs text-slate-500">No windows found</p>
                  )}
                </div>
              )}
            </div>

            {onboardError && (
              <p className="text-xs text-red-400">{onboardError}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setOnboardOpen(false)}
                className="px-3 py-1.5 rounded text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleOnboard()}
                disabled={
                  onboardLoading ||
                  onboardTemplateId === '' ||
                  onboardWindow === null ||
                  !room
                }
                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 rounded text-sm text-white"
              >
                {onboardLoading ? '…' : 'Onboard'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
