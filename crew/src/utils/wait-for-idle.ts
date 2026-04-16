import { capturePane } from '../tmux/index.ts';

export interface WaitForIdleOptions {
  target: string;        // tmux pane target (e.g. "%5" or "session:0.1")
  stableCount?: number;  // consecutive identical-hash polls needed (default: 3)
  idleSeconds?: number;  // seconds content must be unchanged (default: 5)
  pollInterval?: number; // ms between polls (default: 1000)
  timeout?: number;      // max wait ms (default: 60000)
  lines?: number;        // tail lines to hash (default: 50)
  checkCpu?: boolean;    // also require no CPU growth (default: true)
}

export interface IdleResult {
  idle: boolean;
  content: string;
  elapsed: number;
  timedOut: boolean;
}

/** djb2-style hash — fast, good distribution for terminal content */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h;
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

/** Get pane PID from tmux */
async function getPanePid(target: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(['tmux', 'display-message', '-p', '-t', target, '#{pane_pid}'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const pid = parseInt(out, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Collect all descendant PIDs of a process */
async function getDescendants(rootPid: number): Promise<number[]> {
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const proc = Bun.spawn(['pgrep', '-P', String(current)], {
        stdout: 'pipe', stderr: 'pipe',
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      for (const line of out.split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (!isNaN(pid) && !seen.has(pid)) {
          seen.add(pid);
          queue.push(pid);
        }
      }
    } catch {
      // pgrep may fail if no children — ignore
    }
  }
  return Array.from(seen);
}

/** Parse ps time format (e.g. "0:02.34" or "1-02:03:04") to seconds */
function parseTimeToSeconds(raw: string): number {
  const cleaned = raw.trim().replace(/\.\d+$/, ''); // remove fractional
  let days = 0, rest = cleaned;

  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = parseInt(d, 10) || 0;
    rest = r;
  }

  const parts = rest.split(':').map(p => parseInt(p, 10) || 0);
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else if (parts.length === 1) [s] = parts;

  return days * 86400 + h * 3600 + m * 60 + s;
}

/** Sum CPU time (in seconds) for a list of PIDs */
async function getCpuTotal(pids: number[]): Promise<number> {
  if (pids.length === 0) return 0;
  try {
    const proc = Bun.spawn(['ps', '-o', 'time=', '-p', pids.join(',')], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    let total = 0;
    for (const line of out.split('\n')) {
      if (line.trim()) total += parseTimeToSeconds(line);
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Polls a tmux pane until its content is stable (unchanged hash) for
 * `stableCount` consecutive polls AND `idleSeconds` wall-clock seconds
 * AND (if checkCpu=true) no CPU growth in the pane's process tree.
 *
 * Returns immediately with timedOut=true if `timeout` ms elapses.
 */
export async function waitForIdle(options: WaitForIdleOptions): Promise<IdleResult> {
  const {
    target,
    stableCount = 3,
    idleSeconds = 5,
    pollInterval = 1000,
    timeout = 60_000,
    lines = 50,
    checkCpu = true,
  } = options;

  const start = Date.now();
  let stableStreak = 0;
  let lastHash: number | null = null;
  let lastChangeAt = start;
  let lastContent = '';
  let baselineCpu = 0;
  let panePid: number | null = null;

  // Get pane PID once for CPU monitoring
  if (checkCpu) {
    panePid = await getPanePid(target);
    if (panePid) {
      const descendants = await getDescendants(panePid);
      baselineCpu = await getCpuTotal(descendants);
    }
  }

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      return { idle: false, content: lastContent, elapsed, timedOut: true };
    }

    const raw = await capturePane(target);
    if (raw !== null) {
      const tail = tailLines(raw, lines);
      const hash = hashString(tail);
      lastContent = raw;

      if (hash === lastHash) {
        stableStreak++;
      } else {
        // Content changed — reset everything
        stableStreak = 1;
        lastHash = hash;
        lastChangeAt = Date.now();
        if (checkCpu && panePid) {
          const descendants = await getDescendants(panePid);
          baselineCpu = await getCpuTotal(descendants);
        }
      }

      const stableMs = Date.now() - lastChangeAt;
      const hashStable = stableStreak >= stableCount && stableMs >= idleSeconds * 1000;

      // Check CPU growth if enabled
      let cpuIdle = true;
      if (checkCpu && panePid && hashStable) {
        const descendants = await getDescendants(panePid);
        const cpuNow = await getCpuTotal(descendants);
        cpuIdle = cpuNow <= baselineCpu; // no growth = idle
      }

      if (hashStable && cpuIdle) {
        return { idle: true, content: raw, elapsed: Date.now() - start, timedOut: false };
      }
    }

    await Bun.sleep(pollInterval);
  }
}
