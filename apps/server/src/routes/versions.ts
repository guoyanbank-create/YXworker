/** 版本路由：版本列表、创建命名版本、回退到历史版本。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { badRequest } from '../errors.js';
import {
  createVersion,
  listVersions,
  restoreVersion,
} from '../services/versionsService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const createVersionSchema = z.object({
  name: z.string().trim().min(1).max(100),
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

export function createVersionsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/documents/:id/versions', (req, res) => {
    res.json({ versions: listVersions(db, req.params.id) });
  });

  router.post('/documents/:id/versions', (req, res) => {
    const body = parseBody(createVersionSchema, req.body);
    const version = transaction(db, () =>
      createVersion(db, req.params.id, body.name, 'user'),
    );
    res.status(201).json({ version });
  });

  router.post('/versions/:id/restore', (req, res) => {
    const document = transaction(db, () => restoreVersion(db, req.params.id));
    res.json({ document });
  });

  return router;
}
