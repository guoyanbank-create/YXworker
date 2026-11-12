/** P2 功能清单路由（API_CONTRACT P2-6）：FeatureSpec CRUD 与枚举校验。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { badRequest } from '../errors.js';
import {
  createFeature,
  deleteFeature,
  FEATURE_PRIORITIES,
  FEATURE_STATUSES,
  getFeature,
  listFeatures,
  updateFeature,
} from '../services/featuresService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const statusSchema = z.enum(FEATURE_STATUSES);
const prioritySchema = z.enum(FEATURE_PRIORITIES);

const createFeatureSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(4000).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  chapterRef: z.string().max(300).nullable().optional(),
  diagramId: z.string().trim().min(1).nullable().optional(),
});

const updateFeatureSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(4000).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  chapterRef: z.string().max(300).nullable().optional(),
  diagramId: z.string().trim().min(1).nullable().optional(),
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

export function createFeaturesRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/projects/:id/features', (req, res) => {
    res.json({ features: listFeatures(db, req.params.id) });
  });

  router.post('/projects/:id/features', (req, res) => {
    const body = parseBody(createFeatureSchema, req.body);
    const feature = transaction(db, () => createFeature(db, req.params.id, body));
    res.status(201).json({ feature });
  });

  router.get('/features/:id', (req, res) => {
    res.json({ feature: getFeature(db, req.params.id) });
  });

  router.patch('/features/:id', (req, res) => {
    const body = parseBody(updateFeatureSchema, req.body);
    const feature = transaction(db, () => updateFeature(db, req.params.id, body));
    res.json({ feature });
  });

  router.delete('/features/:id', (req, res) => {
    transaction(db, () => deleteFeature(db, req.params.id));
    res.status(204).end();
  });

  return router;
}
