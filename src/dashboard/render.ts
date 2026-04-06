import type { TerminalSize } from './terminal.ts';
import { COLORS } from './terminal.ts';
import type { TreeNode } from './tree.ts';
import type { FormattedMessage } from './feed.ts';
import type { Agent, AgentStatus, Room } from '../shared/types.ts';
import type { AgentStatusEntry } from './status.ts';

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' } as const;

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: COLORS.green, busy: COLORS.yellow, dead: COLORS.red, unknown: COLORS.gray,
};

function moveTo(row: number, col: number): string { return `\x1b[${row + 1};${col + 1}H`; }

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function truncate(str: string, max: number): string {
  if (visibleLength(str) <= max) return str;
  let result = '';
  let visible = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      // Consume ANSI escape sequence (ends at first letter after '[')
      let j = i + 2;
      while (j < str.length && !/[A-Za-z]/.test(str[j])) j++;
      result += str.slice(i, j + 1);
      i = j + 1;
    } else {
      if (visible >= max - 1) {
        result += '…\x1b[0m';
        return result;
      }
      result += str[i];
      visible++;
      i++;
    }
  }
  return result;
}

function wrapLines(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let remaining = raw;
    while (remaining.length > width && lines.length < maxLines) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    if (lines.length < maxLines) lines.push(remaining);
    if (lines.length >= maxLines) break;
  }
  return lines.slice(0, maxLines);
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

function renderHelpOverlay(size: TerminalSize): string {
  const lines = [
    '╭─── Help ───────────────────╮',
    '│  ↑/k    Move up            │',
    '│  ↓/j    Move down          │',
    '│  gg     Jump to top        │',
    '│  G      Jump to bottom     │',
    '│  Enter  Toggle collapse    │',
    '│  ?      Toggle this help   │',
    '│  q      Quit               │',
    '╰───────────────────────────-╯',
  ];
  const startRow = Math.floor((size.rows - lines.length) / 2);
  const startCol = Math.floor((size.cols - 30) / 2);
  let buf = '';
  for (let i = 0; i < lines.length; i++) {
    buf += moveTo(startRow + i, startCol) + COLORS.bold + lines[i] + COLORS.reset;
  }
  return buf;
}

export function renderFrame(
  size: TerminalSize, treeNodes: TreeNode[], selectedIndex: number,
  feedMessages: FormattedMessage[], selectedAgent: Agent | null,
  selectedAgentStatus: AgentStatusEntry | null, stateAvailable: boolean,
  roomFilter: string | null = null, rooms?: Record<string, Room>, showHelp = false,
): string {
  let buf = '\x1b[2J';
  const leftW = Math.max(20, Math.floor(size.cols * 0.3));
  const rightW = size.cols - leftW;
  const topH = Math.max(5, Math.floor(size.rows * 0.65));
  const bottomH = size.rows - topH;
  const msgTitle = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

  buf += drawBox(0, 0, leftW, size.rows, 'Rooms & Agents');
  buf += drawBox(leftW, 0, rightW, topH, msgTitle);
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
      const selectedText = truncate(plain, treeW);
      buf += moveTo(row, 1) + COLORS.inverse + selectedText + ' '.repeat(Math.max(0, treeW - selectedText.length)) + COLORS.reset;
    } else {
      buf += moveTo(row, 1) + truncate(line, treeW);
    }
  }

  if (startIdx > 0) {
    buf += moveTo(1, leftW - 2) + COLORS.dim + '▲' + COLORS.reset;
  }
  if (startIdx + treeMaxLines < treeNodes.length) {
    buf += moveTo(size.rows - 2, leftW - 2) + COLORS.dim + '▼' + COLORS.reset;
  }

  // Message feed
  const feedMaxLines = topH - 2;
  const feedW = rightW - 3;
  let displayMsgs = feedMessages;
  if (roomFilter) {
    displayMsgs = feedMessages.filter(m => m.room === roomFilter);
  }
  const visibleMsgs = displayMsgs.slice(-feedMaxLines);
  const totalFilteredMsgs = displayMsgs.length;

  if (totalFilteredMsgs > feedMaxLines) {
    const moreAbove = totalFilteredMsgs - feedMaxLines;
    buf += moveTo(1, leftW + rightW - 12) + COLORS.dim + `↑ ${moreAbove} more` + COLORS.reset;
  }

  for (let i = 0; i < visibleMsgs.length; i++) {
    const msg = visibleMsgs[i]!;
    const target = msg.target === 'ALL' ? `${COLORS.bold}ALL${COLORS.reset}` : msg.target;
    const kindBadgeText = msg.kind === 'completion' ? '[DONE] '
      : msg.kind === 'error' ? '[ERR] '
      : msg.kind === 'question' ? '[?] '
      : msg.kind === 'task' ? '[TASK] '
      : '';
    const kindBadge = msg.kind === 'completion' ? `${COLORS.green}[DONE]${COLORS.reset} `
      : msg.kind === 'error' ? `${COLORS.red}[ERR]${COLORS.reset} `
      : msg.kind === 'question' ? `${COLORS.yellow}[?]${COLORS.reset} `
      : msg.kind === 'task' ? `${COLORS.cyan}[TASK]${COLORS.reset} `
      : '';
    const targetText = msg.target === 'ALL' ? 'ALL' : msg.target;
    const prefixLen = ` ${msg.timestamp} ${kindBadgeText}[${msg.sender}@${msg.room}] → ${targetText}: `.length;
    const text = truncate(msg.text, Math.max(5, feedW - prefixLen));
    const line = ` ${COLORS.dim}${msg.timestamp}${COLORS.reset} ${kindBadge}${msg.roomColor}[${msg.sender}@${msg.room}]${COLORS.reset} → ${target}: ${text}`;
    buf += moveTo(1 + i, leftW + 1) + truncate(line, feedW);
  }

  if (visibleMsgs.length === 0) {
    buf += moveTo(1, leftW + 2) + COLORS.dim + 'No messages yet' + COLORS.reset;
  }

  const shortcutBar = '↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit';
  buf += moveTo(size.rows - 1, 0) + COLORS.dim + truncate(shortcutBar, size.cols).padEnd(size.cols) + COLORS.reset;

  // Details panel
  const detailCol = leftW + 2;
  let detailRow = topH + 1;

  if (!selectedAgent) {
    const selectedNode = treeNodes[selectedIndex];
    if (selectedNode?.type === 'room') {
      const roomName = selectedNode.label;
      const room = rooms?.[roomName] as (Room & { topic?: string }) | undefined;
      buf += moveTo(detailRow++, detailCol) + `${COLORS.bold}${roomName}${COLORS.reset}`;
      if (room?.topic) {
        buf += moveTo(detailRow++, detailCol) + `Topic: ${room.topic}`;
      }
      buf += moveTo(detailRow++, detailCol) + `Members: ${selectedNode.memberCount}`;
    } else {
      buf += moveTo(detailRow, detailCol) + COLORS.dim + 'No agent selected' + COLORS.reset;
    }
  } else {
    const status = selectedAgentStatus?.status ?? 'unknown';
    const sc = STATUS_COLORS[status];
    const roomTopic = roomFilter ? rooms?.[roomFilter]?.topic : undefined;
    buf += moveTo(detailRow++, detailCol) + `${COLORS.bold}${selectedAgent.name}${COLORS.reset}`;
    buf += moveTo(detailRow++, detailCol) + `Role: ${selectedAgent.role}`;
    buf += moveTo(detailRow++, detailCol) + `Rooms: ${selectedAgent.rooms.join(', ')}`;
    if (roomTopic) {
      buf += moveTo(detailRow++, detailCol) + `Topic: ${truncate(roomTopic, rightW - 6)}`;
    }
    buf += moveTo(detailRow++, detailCol) + `Status: ${sc}${status}${COLORS.reset}`;
    buf += moveTo(detailRow++, detailCol) + `Pane: ${COLORS.dim}${selectedAgent.tmux_target}${COLORS.reset}`;
    if (selectedAgent.last_activity) {
      const secs = Math.floor((Date.now() - new Date(selectedAgent.last_activity).getTime()) / 1000);
      const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
      buf += moveTo(detailRow++, detailCol) + `Last activity: ${COLORS.dim}${ago} ago${COLORS.reset}`;
    }
    if (selectedAgentStatus?.summary) {
      buf += moveTo(detailRow++, detailCol) + 'Activity:';
      for (const line of wrapLines(selectedAgentStatus.summary, Math.max(10, rightW - 6), 3)) {
        buf += moveTo(detailRow++, detailCol) + `${COLORS.dim}${truncate(line, rightW - 6)}${COLORS.reset}`;
      }
    }
  }

  if (showHelp) buf += renderHelpOverlay(size);

  return buf;
}
