import { join } from 'path';
import { initDb } from '../state/db.ts';
import { handleApi } from './api.ts';
import { wsOpen, wsClose, startWsPoller, stopWsPoller } from './ws.ts';

export interface ServeOptions {
  port?: number;
  host?: string;
}

const STATIC_PLACEHOLDER = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Crew Dashboard</title></head>
<body>
  <h1>Crew Browser Dashboard</h1>
  <p>Phase B frontend not yet built. API is available at <a href="/api/rooms">/api/rooms</a>.</p>
  <p>WebSocket endpoint: <code>ws://localhost/ws</code></p>
</body>
</html>`;

export function startServer(opts: ServeOptions = {}): ReturnType<typeof Bun.serve> {
  const port = opts.port ?? parseInt(process.env.CREW_SERVE_PORT ?? '3456', 10);
  const hostname = opts.host ?? process.env.CREW_SERVE_HOST ?? '127.0.0.1';

  initDb();

  const server = Bun.serve({
    port,
    hostname,

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        if (server.upgrade(req)) return undefined as any;
        return new Response('WebSocket upgrade failed', { status: 426 });
      }

      // REST API
      if (url.pathname.startsWith('/api/')) {
        return handleApi(req);
      }

      // Static file serving from crew/dist/web/
      // Bun.file derives Content-Type from file extension (JS, CSS, etc.)
      // Paths that don't resolve to a file fall back to index.html for SPA client-routing.
      const distDir = new URL('../../dist/web/', import.meta.url).pathname;
      const cleaned = url.pathname === '/' ? '/index.html' : url.pathname;
      if (cleaned.includes('..')) return new Response('Forbidden', { status: 400 });
      const file = Bun.file(join(distDir, cleaned));
      return file.exists().then(async exists => {
        if (exists) return new Response(file);
        const index = Bun.file(join(distDir, 'index.html'));
        if (await index.exists()) return new Response(index);
        return new Response(STATIC_PLACEHOLDER, { headers: { 'Content-Type': 'text/html' } });
      });
    },

    websocket: {
      open: wsOpen,
      close: wsClose,
      message() {}, // clients don't send; reads/actions go over REST
    },
  });

  startWsPoller();
  return server;
}

export function stopServer(server: ReturnType<typeof Bun.serve>): void {
  stopWsPoller();
  server.stop(true);
}
