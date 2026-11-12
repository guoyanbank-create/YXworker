/** 运行记录路由（API_CONTRACT §2/§7）：项目运行列表、运行状态/事件、取消运行。 */
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import * as runService from '../services/runService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

export function createRunsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  // API_CONTRACT §2：GET /api/projects/:id/runs?limit=20（按创建时间倒序）。
  router.get('/projects/:id/runs', (req, res) => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) throw notFound('not_found', `项目不存在: ${req.params.id}`);
    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 20;
    res.json({ runs: runService.listRunsByProject(db, req.params.id, limit) });
  });

  router.get('/runs/:id', (req, res) => {
    const run = runService.getRun(db, req.params.id);
    res.json({ run });
  });

  router.post('/runs/:id/cancel', (req, res) => {
    // 仅 queued/running 可取消；已结束为幂等返回当前运行记录（不改状态）。
    const before = runService.getRun(db, req.params.id);
    const run = runService.cancelRun(db, before.id);
    if (run.status === 'cancelled') runService.abortRunExecution(run.id);
    res.json({ run });
  });

  return router;
}
