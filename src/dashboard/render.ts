import type { TerminalSize } from './terminal.ts';
import { COLORS } from './terminal.ts';
import type { TreeNode } from './tree.ts';
import type { FormattedMessage } from './feed.ts';
import type { Agent, AgentStatus } from '../shared/types.ts';
import type { AgentStatusEntry } from './status.ts';

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' } as const;

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: COLORS.green, busy: COLORS.yellow, dead: COLORS.red, unknown: COLORS.gray,
};

function moveTo(row: number, col: number): string { return `\x1b[${row + 1};${col + 1}H`; }

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function drawBox(x: number, y: number, w: number, h: number, title: string): string {
  let buf = '';
  const inner = w - 2;
  const t = title ? ` ${title} ` : '';
  const rem = Math.max(0, inner - t.length);
  buf += moveTo(y, x) + COLORS.dim + BOX.tl + BOX.h + COLORS.reset + COLORS.bold + t + COLORS.reset + COLORS.dim + BOX.h.repeat(rem) + BOX.tr + COLORS.reset;
  for (let r = 1; r < h - 1; r++) {
    buf += moveTo(y + r, x) + COLORS.dim + BOX.v + COLORS.reset;
    buf += moveTo(y + r, x + w - 1) + COLORS.dim + BOX.v + COLORS.reset;
  }
  buf += moveTo(y + h - 1, x) + COLORS.dim + BOX.bl + BOX.h.repeat(inner) + BOX.br + COLORS.reset;
  return buf;
}

export function renderFrame(
  size: TerminalSize, treeNodes: TreeNode[], selectedIndex: number,
  feedMessages: FormattedMessage[], selectedAgent: Agent | null,
  selectedAgentStatus: AgentStatusEntry | null, stateAvailable: boolean,
): string {
  let buf = '\x1b[2J';
  const leftW = Math.max(20, Math.floor(size.cols * 0.3));
  const rightW = size.cols - leftW;
  const topH = Math.max(5, Math.floor(size.rows * 0.65));
  const bottomH = size.rows - topH;

  buf += drawBox(0, 0, leftW, size.rows, 'Rooms & Agents');
  buf += drawBox(leftW, 0, rightW, topH, 'Messages');
  buf += drawBox(leftW, topH, rightW, bottomH, 'Details');

  if (!stateAvailable) {
    const msg = 'Waiting for cc-tmux...';
    buf += moveTo(Math.floor(size.rows / 2), Math.max(1, Math.floor((leftW - msg.length) / 2))) + COLORS.dim + msg + COLORS.reset;
    return buf;
  }

  // Tree panel
  const treeMaxLines = size.rows - 2;
  let startIdx = 0;
  if (selectedIndex >= treeMaxLines) startIdx = selectedIndex - treeMaxLines + 1;
  const visible = treeNodes.slice(startIdx, startIdx + treeMaxLines);
  const treeW = leftW - 3;

  for (let i = 0; i < visible.length; i++) {
    const node = visible[i]!;
    const row = 1 + i;
    const isSel = (startIdx + i) === selectedIndex;
    let line = '';

    if (node.type === 'room') {
      line = ` ${node.collapsed ? '▶' : '▼'} ${node.label} (${node.memberCount})`;
    } else {
      const sc = STATUS_COLORS[node.status ?? 'unknown'];
      const badge = node.extraRooms?.length ? ` ${COLORS.dim}[+${node.extraRooms[0]}]${COLORS.reset}` : '';
      line = `   ${sc}●${COLORS.reset} ${node.label}${badge}`;
    }

    if (isSel) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
      buf += moveTo(row, 1) + COLORS.inverse + truncate(plain, treeW).padEnd(treeW) + COLORS.reset;
    } else {
      buf += moveTo(row, 1) + truncate(line, treeW + 20);
    }
  }

  // Message feed
  const feedMaxLines = topH - 2;
  const feedW = rightW - 3;
  const visibleMsgs = feedMessages.slice(-feedMaxLines);

  for (let i = 0; i < visibleMsgs.length; i++) {
    const msg = visibleMsgs[i]!;
    const target = msg.target === 'ALL' ? `${COLORS.bold}ALL${COLORS.reset}` : msg.target;
    const line = ` ${COLORS.dim}${msg.timestamp}${COLORS.reset} ${msg.roomColor}[${msg.sender}@${msg.room}]${COLORS.reset} → ${target}: ${msg.text}`;
    buf += moveTo(1 + i, leftW + 1) + truncate(line, feedW + 40);
  }

  if (visibleMsgs.length === 0) {
    buf += moveTo(1, leftW + 2) + COLORS.dim + 'No messages yet' + COLORS.reset;
  }

  // Details panel
  const detailCol = leftW + 2;
  let detailRow = topH + 1;

  if (!selectedAgent) {
    buf += moveTo(detailRow, detailCol) + COLORS.dim + 'No agent selected' + COLORS.reset;
  } else {
    const status = selectedAgentStatus?.status ?? 'unknown';
    const sc = STATUS_COLORS[status];
    buf += moveTo(detailRow++, detailCol) + `${COLORS.bold}${selectedAgent.name}${COLORS.reset}`;
    buf += moveTo(detailRow++, detailCol) + `Role: ${selectedAgent.role}`;
    buf += moveTo(detailRow++, detailCol) + `Rooms: ${selectedAgent.rooms.join(', ')}`;
    buf += moveTo(detailRow++, detailCol) + `Status: ${sc}${status}${COLORS.reset}`;
    buf += moveTo(detailRow++, detailCol) + `Pane: ${COLORS.dim}${selectedAgent.tmux_target}${COLORS.reset}`;
    if (selectedAgent.last_activity) {
      const secs = Math.floor((Date.now() - new Date(selectedAgent.last_activity).getTime()) / 1000);
      const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
      buf += moveTo(detailRow++, detailCol) + `Last activity: ${COLORS.dim}${ago} ago${COLORS.reset}`;
    }
  }

  return buf;
}
