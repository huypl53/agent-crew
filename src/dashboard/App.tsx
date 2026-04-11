import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { useStateReader } from './hooks/useStateReader.ts';
import { useTree } from './hooks/useTree.ts';
import { useFeed } from './hooks/useFeed.ts';
import { useStatus } from './hooks/useStatus.ts';
import { TreePanel } from './components/TreePanel.tsx';
import { MessageFeedPanel } from './components/MessageFeed.tsx';
import { DetailsPanel } from './components/DetailsPanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { HelpOverlay } from './components/HelpOverlay.tsx';
import { HeaderStats } from './components/HeaderStats.tsx';
import { hasErrors, logError } from './logger.ts';
import type { MessageKind } from '../shared/types.ts';

const POLL_INTERVAL = 2000;
const ALL_KINDS: MessageKind[] = ['task', 'completion', 'error', 'question', 'status', 'chat'];

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  // Pre-compute fixed layout dimensions — avoids Yoga percentage recalculation
  const layout = useMemo(() => {
    const treeW = Math.floor(cols * 0.3);
    const panelRows = rows - 2; // header stats + status bar
    const topH = Math.max(5, Math.floor(panelRows * 0.65));
    const bottomH = panelRows - topH;
    return { treeW, topH, bottomH, panelRows };
  }, [rows, cols]);

  const { state, isAvailable } = useStateReader();
  const earliestJoinedAt = useMemo(() => {
    let earliest: string | null = null;
    for (const agent of Object.values(state.agents)) {
      if (!earliest || agent.joined_at < earliest) earliest = agent.joined_at;
    }
    return earliest;
  }, [state.agents]);
  const { statuses, pollAll, getStatus } = useStatus();
  const { messages, update: updateFeed } = useFeed();
  const tree = useTree(state.agents, state.rooms, statuses);
  const [showHelp, setShowHelp] = useState(false);
  const [enabledKinds, setEnabledKinds] = useState<Set<MessageKind>>(new Set(ALL_KINDS));

  // Update feed when state changes
  useEffect(() => { updateFeed(state.messages); }, [state.messages]);

  // Poll agent statuses
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        if (Object.keys(state.agents).length > 0) await pollAll(state.agents);
      } catch (e) { logError('app.poll', e); }
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [state.agents, pollAll]);

  // Keyboard handling
  // Memoize derived selection state — must be before early return to keep hook count stable
  const agent = useMemo(
    () => tree.selectedAgentName ? state.agents[tree.selectedAgentName] ?? null : null,
    [tree.selectedAgentName, state.agents],
  );
  const agentStatus = useMemo(
    () => tree.selectedAgentName ? getStatus(tree.selectedAgentName) : null,
    [tree.selectedAgentName, statuses],
  );
  const isSyncing = tree.selectedAgentName !== null && agent === null;

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === '?') { setShowHelp(h => !h); return; }
    const kindMap: Record<string, MessageKind> = { '1': 'task', '2': 'completion', '3': 'error', '4': 'question', '5': 'status', '6': 'chat' };
    if (kindMap[input]) {
      setEnabledKinds(prev => {
        const next = new Set(prev);
        if (next.has(kindMap[input]!)) next.delete(kindMap[input]!);
        else next.add(kindMap[input]!);
        return next;
      });
      return;
    }
    if (input === 'k' || key.upArrow) { tree.moveUp(); return; }
    if (input === 'j' || key.downArrow) { tree.moveDown(); return; }
    if (input === 'g') { tree.moveToTop(); return; }
    if (input === 'G') { tree.moveToBottom(); return; }
    if (key.return) { tree.toggleCollapse(); return; }
  });

  if (!isAvailable) {
    return (
      <Box flexDirection="column" height={rows} width={cols} justifyContent="center" alignItems="center">
        <Text dimColor>Waiting for cc-tmux...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <HeaderStats statuses={statuses} messages={state.messages} tasks={state.tasks} earliestJoinedAt={earliestJoinedAt} cols={cols} />
      <Box flexDirection="row" height={layout.panelRows}>
        <TreePanel nodes={tree.nodes} selectedIndex={tree.selectedIndex} height={layout.panelRows} width={layout.treeW} statuses={statuses} messages={state.messages} tasks={state.tasks} />
        <Box flexDirection="column" flexGrow={1}>
          <MessageFeedPanel messages={messages} roomFilter={tree.selectedRoomName} height={layout.topH} enabledKinds={enabledKinds} />
          {showHelp ? (
            <Box flexDirection="column" borderStyle="single" height={layout.bottomH} justifyContent="center" alignItems="center">
              <HelpOverlay />
            </Box>
          ) : (
            <DetailsPanel
              agent={agent}
              agentStatus={agentStatus}
              selectedNode={tree.selectedNode}
              rooms={state.rooms}
              messages={state.messages}
              tasks={state.tasks}
              isSyncing={isSyncing}
              height={layout.bottomH}
            />
          )}
        </Box>
      </Box>
      <StatusBar hasErrors={hasErrors()} showHelp={showHelp} />
    </Box>
  );
}
