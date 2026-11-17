import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/index.js';

const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const rawUrl = req.url || '/';
  if (!rawUrl.startsWith('/api')) {
    req.url = rawUrl === '/' ? '/api' : `/api${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
  }
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
