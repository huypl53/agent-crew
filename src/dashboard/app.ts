import { initTerminal, onInput, onResize, cleanup, writeFrame, getTerminalSize } from './terminal.ts';
import type { TerminalSize } from './terminal.ts';
import { StateReader } from './state-reader.ts';
import { StatusPoller } from './status.ts';
import { TreeState } from './tree.ts';
import { MessageFeed } from './feed.ts';
import { renderFrame } from './render.ts';
import { logError } from './logger.ts';

const POLL_INTERVAL = 2000;

export async function startApp(): Promise<void> {
  let size: TerminalSize = initTerminal();
  const stateReader = new StateReader();
  const statusPoller = new StatusPoller();
  const tree = new TreeState();
  const feed = new MessageFeed();
  let showHelp = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onInput(async (key) => {
    switch (key) {
      case 'up': tree.moveUp(); draw(); break;
      case 'down': tree.moveDown(); draw(); break;
      case 'help': showHelp = !showHelp; draw(); break;
      case 'home': tree.moveToTop(); draw(); break;
      case 'end': tree.moveToBottom(); draw(); break;
      case 'enter': case 'space':
        tree.toggleCollapse();
        tree.build(stateReader.current.agents, stateReader.current.rooms, statusPoller.all);
        draw();
        break;
      case 'q': case 'ctrl-c':
        if (pollTimer) clearInterval(pollTimer);
        stateReader.stop();
        cleanup();
        process.exit(0);
    }
  });

  onResize((s) => { size = s; draw(); });

  stateReader.setChangeHandler((state) => {
    feed.update(state.messages);
    tree.build(state.agents, state.rooms, statusPoller.all);
    draw();
  });

  await stateReader.init();
  feed.update(stateReader.current.messages);
  tree.build(stateReader.current.agents, stateReader.current.rooms, statusPoller.all);
  draw();

  pollTimer = setInterval(async () => {
    try {
      const state = stateReader.current;
      if (Object.keys(state.agents).length > 0) await statusPoller.pollAll(state.agents);
      tree.build(state.agents, state.rooms, statusPoller.all);
      feed.update(state.messages);
      draw();
    } catch (e) { logError('app.poll', e); }
  }, POLL_INTERVAL);

  function draw(): void {
    const state = stateReader.current;
    const agentName = tree.selectedAgentName;
    const agent = agentName ? state.agents[agentName] ?? null : null;
    const isSyncing = agentName !== null && agent === null;
    const status = agentName ? statusPoller.getStatus(agentName) : null;
    const roomFilter = tree.selectedRoomName;
    writeFrame(renderFrame(
      size,
      tree.items,
      tree.selected,
      feed.messages,
      agent,
      status,
      stateReader.isAvailable,
      roomFilter,
      state.rooms,
      showHelp,
      isSyncing,
    ));
  }
}
