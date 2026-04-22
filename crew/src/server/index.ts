import { existsSync } from 'fs';
import { join } from 'path';
import { initDb } from '../state/db.ts';
import { handleApi } from './api.ts';
import { startSweep, stopSweep } from './sweep.ts';
import { startWsPoller, stopWsPoller, wsClose, wsOpen } from './ws.ts';

export interface ServeOptions {
  port?: number;
  host?: string;
  headless?: boolean;
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

export type ServerHandle = ReturnType<typeof Bun.serve> & {
  headless: boolean;
  shutdown(): void;
};

export async function startServer(
  opts: ServeOptions = {},
): Promise<ServerHandle> {
  const port = opts.port ?? parseInt(process.env.CREW_SERVE_PORT ?? '3456', 10);
  const hostname = opts.host ?? process.env.CREW_SERVE_HOST ?? '127.0.0.1';

  initDb();

  // Headless mode: no HTTP/WS, just the sweep loop
  if (opts.headless) {
    startSweep();
    return {
      headless: true,
      shutdown: () => stopSweep(),
    } as unknown as ServerHandle;
  }

  // Auto-build web app if dist/web/ is missing
  const distDir = new URL('../../dist/web/', import.meta.url).pathname;
  if (!existsSync(join(distDir, 'index.html'))) {
    console.log('[crew] Web app not built. Running build:web...');
    const proc = Bun.spawn(['bun', 'run', 'build:web'], {
      cwd: join(import.meta.dir, '../..'),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await proc.exited;
  }

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
      const distDir = new URL('../../dist/web/', import.meta.url).pathname;
      const cleaned = url.pathname === '/' ? '/index.html' : url.pathname;
      if (cleaned.includes('..'))
        return new Response('Forbidden', { status: 400 });
      const file = Bun.file(join(distDir, cleaned));
      return file.exists().then(async (exists) => {
        if (exists) return new Response(file);
        const index = Bun.file(join(distDir, 'index.html'));
        if (await index.exists()) return new Response(index);
        return new Response(STATIC_PLACEHOLDER, {
          headers: { 'Content-Type': 'text/html' },
        });
      });
    },

    websocket: {
      open: wsOpen,
      close: wsClose,
      message() {},
    },
  });

  startWsPoller();
  startSweep();
  return Object.assign(server, {
    headless: false,
    shutdown() {
      stopWsPoller();
      stopSweep();
      server.stop(true);
    },
  });
}
