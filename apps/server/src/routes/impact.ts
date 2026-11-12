/** P2 ImpactPlan 路由（API_CONTRACT P2-7 / P2-8）：影响计算、执行与批量采纳。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import {
  batchAcceptProposals,
  createImpactPlan,
  executeImpactPlan,
  getImpactPlan,
} from '../services/impactService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const createPlanSchema = z.object({
  proposalIds: z.array(z.string().trim().min(1)).max(200).optional(),
  trigger: z.string().trim().max(200).optional(),
});

const executePlanSchema = z.object({
  proposalIds: z.array(z.string().trim().min(1)).max(200).optional(),
  reviewer: z.string().trim().max(120).optional(),
});

const batchAcceptSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(200),
  reviewer: z.string().trim().max(120).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw badRequest(
      'validation_error',
      '请求参数不合法',
      result.error.issues.map((issue) => ({
        path: issue.path.map((part) => String(part)).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function createImpactRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.post('/documents/:id/impact-plan', (req, res) => {
    const body = parseBody(createPlanSchema, req.body);
    const plan = createImpactPlan(db, req.params.id, body);
    res.status(201).json({ plan });
  });

  router.get('/impact-plans/:id', (req, res) => {
    res.json({ plan: getImpactPlan(db, req.params.id) });
  });

  router.post('/impact-plans/:id/execute', (req, res) => {
    const body = parseBody(executePlanSchema, req.body);
    // 执行 = 逐条采纳（每条各自事务）+ 更新 executedAt，不能套外层事务。
    const result = executeImpactPlan(db, req.params.id, body);
    res.json(result);
  });

  router.post('/documents/:id/proposals/batch-accept', (req, res) => {
    const body = parseBody(batchAcceptSchema, req.body);
    res.json(batchAcceptProposals(db, req.params.id, body.ids, body.reviewer));
  });

  return router;
}
