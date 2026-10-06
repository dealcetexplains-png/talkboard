import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import designHandler from './api/design';
import reviewHandler from './api/review';

// Serves the same api/*.ts handlers Vercel runs, inside the Vite server, so `npm run dev`
// works on localhost with just a .env.local file (no Vercel CLI or login needed).
type Handler = typeof designHandler;
const routes: Record<string, Handler> = { '/api/design': designHandler, '/api/review': reviewHandler };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
      if (data.length > 200_000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const handler = routes[(req.url ?? '').split('?')[0]];
  if (!handler) return next();
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Body must be JSON.' }));
    return;
  }
  // Minimal stand-in for Vercel's response helpers.
  const vres = {
    status(code: number) {
      res.statusCode = code;
      return vres;
    },
    json(payload: unknown) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
    },
  };
  await handler({ method: req.method, body }, vres);
}

function localApi(): Plugin {
  return {
    name: 'talkboard-local-api',
    configureServer(server) {
      server.middlewares.use(apiMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load GEMINI_* from .env / .env.local into the Node process only. Nothing here is exposed to
  // the browser bundle: Vite only exposes variables prefixed with VITE_, and we never use that prefix.
  const env = loadEnv(mode, process.cwd(), 'GEMINI_');
  for (const [key, value] of Object.entries(env)) {
    if (value && !process.env[key]) process.env[key] = value;
  }
  return {
    plugins: [react(), localApi()],
    server: { port: 5173 },
    build: { chunkSizeWarningLimit: 4000 },
  };
});
