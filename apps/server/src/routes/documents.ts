/** 文档路由：读取权威文档、保存正文（乐观锁 + 提案冲突标记联动）。 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { getDocument, replaceDocumentContent } from '../services/documentsService.js';
import { markConflictedProposalsForContentChange } from '../services/proposalService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const saveContentSchema = z.object({
  // 文档结构由 documentsService.assertContentJson 做更细的校验（type=doc）。
  contentJson: z.record(z.string(), z.unknown()),
  baseRevision: z.number().int().nonnegative(),
  actor: z.string().max(100).optional(),
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

export function createDocumentsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/documents/:id', (req, res) => {
    res.json({ document: getDocument(db, req.params.id) });
  });

  router.put('/documents/:id/content', (req, res) => {
    const body = parseBody(saveContentSchema, req.body);
    const documentId = req.params.id;
    const current = getDocument(db, documentId); // 404 优先于冲突判断
    if (body.baseRevision !== current.revision) {
      throw conflict(
        'revision_conflict',
        `文档已被修改（当前 revision=${current.revision}），请刷新后再保存`,
        { currentRevision: current.revision },
      );
    }

    // 文档写入与“提案冲突标记”必须同一事务提交。
    const saved = transaction(db, () => {
      const document = replaceDocumentContent(db, documentId, body.contentJson, {
        actor: body.actor,
      });
      const conflictedProposals = markConflictedProposalsForContentChange(
        db,
        documentId,
        current.paragraphs,
        document.paragraphs,
      );
      return { document, conflictedProposals };
    });

    res.json(saved);
  });

  return router;
}
