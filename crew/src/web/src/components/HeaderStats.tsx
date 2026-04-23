import React, { useEffect, useState } from 'react';
import { get } from '../hooks/useApi.ts';
import type { Stats } from '../types.ts';

function fmt(n: number | null | undefined, decimals = 4): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function Pill({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </span>
  );
}

function Sep() {
  return <span className="text-slate-700 select-none">|</span>;
}

export default function HeaderStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let alive = true;
    const fetch = () =>
      get<Stats>('/stats')
        .then((s) => {
          if (alive) setStats(s);
        })
        .catch(() => undefined);
    fetch();
    const id = setInterval(fetch, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!stats) return null;

  const { agents, tasks, cost } = stats;
  const totalTokens = cost.total_input_tokens + cost.total_output_tokens;

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-slate-800 border-b border-slate-700 text-xs flex-wrap">
      {/* Agents */}
      <span className="text-slate-500 uppercase tracking-widest text-[10px]">
        Agents
      </span>
      <Pill label="busy" value={agents.busy} color="text-yellow-400" />
      <Pill label="idle" value={agents.idle} color="text-green-400" />
      {agents.dead > 0 && (
        <Pill label="dead" value={agents.dead} color="text-red-400" />
      )}
      <Pill label="total" value={agents.total} color="text-slate-300" />

      <Sep />

      {/* Tasks */}
      <span className="text-slate-500 uppercase tracking-widest text-[10px]">
        Tasks
      </span>
      <Pill label="active" value={tasks.active} color="text-blue-400" />
      <Pill label="queued" value={tasks.queued} color="text-slate-400" />
      <Pill label="done" value={tasks.done} color="text-green-400" />
      {tasks.error > 0 && (
        <Pill label="err" value={tasks.error} color="text-red-400" />
      )}

      <Sep />

      {/* Cost */}
      <span className="text-slate-500 uppercase tracking-widest text-[10px]">
        Cost
      </span>
      <Pill
        label="$"
        value={`$${fmt(cost.total_usd, 4)}`}
        color="text-amber-400"
      />
      {totalTokens > 0 && (
        <Pill label="tok" value={fmtK(totalTokens)} color="text-slate-300" />
      )}
    </div>
  );
}
