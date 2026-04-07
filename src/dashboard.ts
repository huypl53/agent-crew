#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import { App } from './dashboard/App.tsx';

const { waitUntilExit } = render(React.createElement(App), {
  maxFps: 60,
  incrementalRendering: true,
  patchConsole: false,
});
await waitUntilExit();
