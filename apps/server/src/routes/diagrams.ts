/** P2 图表路由（API_CONTRACT P2-5）：Mermaid 源码 CRUD 与版本绑定。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { badRequest } from '../errors.js';
import {
  bindDiagram,
  createDiagram,
  deleteDiagram,
  DIAGRAM_KINDS,
  getDiagram,
  listDiagrams,
  updateDiagram,
} from '../services/diagramsService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const kindSchema = z.enum(DIAGRAM_KINDS);

const createDiagramSchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: kindSchema.optional(),
  source: z.string().min(1).max(20000),
  description: z.string().max(4000).optional(),
  chapterRef: z.string().max(300).nullable().optional(),
  versionId: z.string().trim().min(1).optional(),
});

const updateDiagramSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  kind: kindSchema.optional(),
  source: z.string().min(1).max(20000).optional(),
  description: z.string().max(4000).optional(),
  chapterRef: z.string().max(300).nullable().optional(),
  versionId: z.string().trim().min(1).optional(),
});

const bindSchema = z.object({
  versionId: z.string().trim().min(1),
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

export function createDiagramsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/projects/:id/diagrams', (req, res) => {
    res.json({ diagrams: listDiagrams(db, req.params.id) });
  });

  router.post('/projects/:id/diagrams', (req, res) => {
    const body = parseBody(createDiagramSchema, req.body);
    const diagram = transaction(db, () => createDiagram(db, req.params.id, body));
    res.status(201).json({ diagram });
  });

  router.get('/diagrams/:id', (req, res) => {
    res.json({ diagram: getDiagram(db, req.params.id) });
  });

  router.put('/diagrams/:id', (req, res) => {
    const body = parseBody(updateDiagramSchema, req.body);
    const diagram = transaction(db, () => updateDiagram(db, req.params.id, body));
    res.json({ diagram });
  });

  router.post('/diagrams/:id/bind', (req, res) => {
    const body = parseBody(bindSchema, req.body);
    const diagram = transaction(db, () => bindDiagram(db, req.params.id, body.versionId));
    res.json({ diagram });
  });

  router.delete('/diagrams/:id', (req, res) => {
    transaction(db, () => deleteDiagram(db, req.params.id));
    res.status(204).end();
  });

  return router;
}
