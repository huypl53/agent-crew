#!/usr/bin/env bun
import { startApp } from './dashboard/app.ts';

startApp().catch((err) => {
  console.error('Dashboard failed to start:', err);
  process.exit(1);
});
