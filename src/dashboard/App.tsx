import React, { useState, useEffect } from 'react';
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
import { hasErrors, logError } from './logger.ts';

const POLL_INTERVAL = 2000;

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  const { state, isAvailable } = useStateReader();
  const { statuses, pollAll, getStatus } = useStatus();
  const { messages, update: updateFeed } = useFeed();
  const tree = useTree(state.agents, state.rooms, statuses);
  const [showHelp, setShowHelp] = useState(false);

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
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === '?') { setShowHelp(h => !h); return; }
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

  const agent = tree.selectedAgentName ? state.agents[tree.selectedAgentName] ?? null : null;
  const agentStatus = tree.selectedAgentName ? getStatus(tree.selectedAgentName) : null;
  const isSyncing = tree.selectedAgentName !== null && agent === null;

  const topH = Math.max(5, Math.floor((rows - 1) * 0.65));
  const bottomH = rows - 1 - topH;

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <Box flexDirection="row" flexGrow={1}>
        <TreePanel nodes={tree.nodes} selectedIndex={tree.selectedIndex} height={rows - 1} />
        <Box flexDirection="column" flexGrow={1}>
          <MessageFeedPanel messages={messages} roomFilter={tree.selectedRoomName} height={topH} />
          {showHelp ? (
            <Box flexDirection="column" borderStyle="single" height={bottomH} justifyContent="center" alignItems="center">
              <HelpOverlay />
            </Box>
          ) : (
            <DetailsPanel
              agent={agent}
              agentStatus={agentStatus}
              selectedNode={tree.selectedNode}
              rooms={state.rooms}
              messages={state.messages}
              isSyncing={isSyncing}
              height={bottomH}
            />
          )}
        </Box>
      </Box>
      <StatusBar hasErrors={hasErrors()} showHelp={showHelp} />
    </Box>
  );
}
