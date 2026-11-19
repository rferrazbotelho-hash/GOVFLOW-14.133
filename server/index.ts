import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { closeDb, getDb, isServerlessRuntime } from './db/database.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import supportRoutes from './routes/support.js';
import institutionRoutes from './routes/institution.js';
import processesRoutes from './routes/processes.js';
import agentsRoutes from './routes/agents.js';
import exportRoutes from './routes/export.js';
import settingsRoutes from './routes/settings.js';
import tcuRoutes from './routes/tcu.js';
import contractsRoutes from './routes/contracts.js';
import platformRoutes from './routes/platform.js';

export function createApp() {
  getDb();

  const app = express();
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      const walRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
      res.json({
        ok: true,
        service: 'GOVFLOW 14.133',
        db_ok: true,
        journal_mode: walRow?.journal_mode || 'wal',
        persistence_mode: isServerlessRuntime() ? 'serverless_tmp' : 'local_disk',
        uptime_seconds: Math.round(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      res.status(503).json({
        ok: false,
        service: 'GOVFLOW 14.133',
        db_ok: false,
        error: err?.message || 'Banco SQLite indisponível.',
        timestamp: new Date().toISOString()
      });
    }
  });

  app.use('/api', authRoutes);
  app.use('/api', supportRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', institutionRoutes);
  app.use('/api', processesRoutes);
  app.use('/api', agentsRoutes);
  app.use('/api', exportRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', tcuRoutes);
  app.use('/api', contractsRoutes);
  app.use('/api', platformRoutes);

  const distDir = path.resolve(process.cwd(), 'dist');
  if (!process.env.VERCEL && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number(err?.status || err?.statusCode || 500);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: err?.message || 'Erro interno inesperado no servidor GovFlow.'
    });
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('server', 'index.ts')) ||
  (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist-server', 'server', 'index.js')));

if (isMain) {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`[GOVFLOW 14.133] Plataforma Online ativa em http://localhost:${port} (Modo Teste Online habilitado | bind ${host}:${port})`);
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`[GOVFLOW 14.133] Recebido ${signal}. Encerrando conexões e executando checkpoint SQLite...`);
    const forceTimer = setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5000);
    forceTimer.unref();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
