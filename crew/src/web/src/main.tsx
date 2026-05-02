import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Initialize theme class before React renders to prevent flash
try {
  const stored = localStorage.getItem('crew-theme');
  const isDark = stored ? stored === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  if (isDark) document.documentElement.classList.add('dark');
} catch {
  document.documentElement.classList.add('dark');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
