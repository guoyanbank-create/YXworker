/** 导出路由：GET /api/templates、GET /api/documents/:id/export.docx（可选 versionId/template）。 */
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
  DOCUMENT_TEMPLATES,
} from '../services/exportDocx.js';
import { getVersion } from '../services/versionsService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const templateSchema = z.enum(['gov', 'tech']);

const querySchema = z.object({
  versionId: z.string().trim().min(1).optional(),
  template: templateSchema.default('tech'),
});

export function createExportRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  // P2：可用 Word 模板（gov 政务公文 / tech 技术方案）。
  router.get('/templates', (_req, res) => {
    res.json({ templates: DOCUMENT_TEMPLATES });
  });

  router.get('/documents/:id/export.docx', async (req, res, next) => {
    try {
      const document = getDocument(db, req.params.id);
      const query = querySchema.safeParse(req.query);
      if (!query.success) {
        throw badRequest('validation_error', '查询参数不合法', {
          issues: query.error.issues.map((issue) => issue.message),
        });
      }
      const { versionId, template } = query.data;
      let contentJson: unknown = document.contentJson;
      if (versionId) {
        const version = getVersion(db, versionId);
        if (version.documentId !== document.id) {
          throw notFound('not_found', '版本不存在或不属于该文档');
        }
        contentJson = version.contentJson;
      }

      // 模板只影响 Word 版式/字体/行距/页边距，正文内容不变。
      const buffer = await buildDocxBuffer(contentJson, template);
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
