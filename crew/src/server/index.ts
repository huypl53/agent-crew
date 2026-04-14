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

      // Static: Phase B will write its Vite build to crew/dist/web/
      // For now serve a placeholder. When dist/web/index.html exists, serve it.
      const distPath = new URL('../../../dist/web/index.html', import.meta.url).pathname;
      const distFile = Bun.file(distPath);
      return distFile.exists().then(exists => {
        if (exists) return new Response(distFile);
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
