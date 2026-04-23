import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0a0f1e',
        panel: '#141926',
        panelElev: '#1a202c',
        border: '#232a3d',
        accent: '#14b8a6',
        accentDim: 'rgba(20,184,166,0.15)',
        text: {
          primary: '#e2e8f0',
          secondary: '#94a3b8',
          muted: '#64748b',
        },
        status: {
          queued: '#64748b',
          active: '#f59e0b',
          done: '#10b981',
          error: '#ef4444',
          idle: '#64748b',
          busy: '#f59e0b',
          dead: '#ef4444',
        },
        kind: {
          root: '#94a3b8',
          room: '#3b82f6',
          agent: '#f97316',
          task: '#8b5cf6',
          message: '#10b981',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
