/** Express 应用装配：API 路由 + Web 静态资源 + 统一错误处理。 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { createProjectsRouter } from './routes/projects.js';
import { createDocumentsRouter } from './routes/documents.js';
import { createVersionsRouter } from './routes/versions.js';
import { createReferencesRouter } from './routes/references.js';
import { createExportRouter } from './routes/export.js';
import { createProposalsRouter } from './routes/proposals.js';
import { createRunsRouter } from './routes/runs.js';
import { createStatusRouter } from './routes/status.js';

export interface AppDeps {
  db: Db;
  config: AppConfig;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));

  // 请求日志：只记录方法/路径/状态/耗时，绝不记录请求体（可能含文档正文）。
  if (process.env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on('finish', () => {
        if (req.path.startsWith('/api')) {
          console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
        }
      });
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: deps.config.appName, version: deps.config.version, time: new Date().toISOString() });
  });

  app.use('/api', createStatusRouter(deps));
  app.use('/api', createProjectsRouter(deps));
  app.use('/api', createDocumentsRouter(deps));
  app.use('/api', createVersionsRouter(deps));
  app.use('/api', createReferencesRouter(deps));
  app.use('/api', createExportRouter(deps));
  app.use('/api', createProposalsRouter(deps));
  app.use('/api', createRunsRouter(deps));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'API 路由不存在' } });
  });

  // 生产模式：由同一端口提供已构建的 Web 单页（本机一条命令启动）。
  if (existsSync(deps.config.webDist)) {
    app.use(express.static(deps.config.webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(join(deps.config.webDist, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { code: 'invalid_json', message: '请求体不是合法 JSON' } });
      return;
    }
    console.error('[server] 未处理错误:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: 'internal_error', message: '服务端内部错误' } });
  });

  return app;
}
