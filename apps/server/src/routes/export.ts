/** 导出路由：GET /api/documents/:id/export.docx（可选 versionId）。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getDocument } from '../services/documentsService.js';
import {
  buildDocxBuffer,
  contentDispositionFor,
  DOCX_MIME,
} from '../services/exportDocx.js';
import { getVersion } from '../services/versionsService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const querySchema = z.object({ versionId: z.string().trim().min(1).optional() });

export function createExportRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/documents/:id/export.docx', async (req, res, next) => {
    try {
      const document = getDocument(db, req.params.id);
      const query = querySchema.safeParse(req.query);
      if (!query.success) {
        throw badRequest('validation_error', '查询参数不合法', {
          issues: query.error.issues.map((issue) => issue.message),
        });
      }
      const versionId = query.data.versionId;
      let contentJson: unknown = document.contentJson;
      if (versionId) {
        const version = getVersion(db, versionId);
        if (version.documentId !== document.id) {
          throw notFound('not_found', '版本不存在或不属于该文档');
        }
        contentJson = version.contentJson;
      }

      const buffer = await buildDocxBuffer(contentJson);
      res.setHeader('Content-Type', DOCX_MIME);
      res.setHeader('Content-Disposition', contentDispositionFor(document.title));
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(buffer);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
