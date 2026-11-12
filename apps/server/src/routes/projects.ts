/** 项目路由：/api/projects 的列表、创建、详情与元数据更新。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { badRequest } from '../errors.js';
import { getDocumentSummary } from '../services/documentsService.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
} from '../services/projectsService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const dataLevelSchema = z.enum(['public', 'internal', 'secret']);

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  dataLevel: dataLevelSchema.optional(),
});

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  dataLevel: dataLevelSchema.optional(),
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

export function createProjectsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/projects', (_req, res) => {
    res.json({ projects: listProjects(db) });
  });

  router.post('/projects', (req, res) => {
    const input = parseBody(createProjectSchema, req.body);
    // 项目 + 空白文档 + V1.0 版本同事务提交。
    const project = transaction(db, () => createProject(db, input));
    res.status(201).json({ project });
  });

  router.get('/projects/:id', (req, res) => {
    const project = getProject(db, req.params.id);
    const document = getDocumentSummary(db, project.documentId);
    res.json({ project, document });
  });

  router.patch('/projects/:id', (req, res) => {
    const patch = parseBody(updateProjectSchema, req.body);
    const project = transaction(db, () => updateProject(db, req.params.id, patch));
    res.json({ project });
  });

  return router;
}
