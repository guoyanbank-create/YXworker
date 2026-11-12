/**
 * 文档服务（契约桩，由 backend-api 负责人实现并替换本文件）。
 * 约定：这些函数不自行 BEGIN/COMMIT 事务；需要多写操作的调用方用 `transaction(db, fn)` 包裹。
 */
import type { Db } from '../db.js';
import type { Document, DocumentSummary } from '../types.js';
import type { PmDoc } from '../domain/paragraphs.js';

export interface ReplaceContentOptions {
  actor?: string;
  reason?: string;
}

export function assertContentJson(_contentJson: unknown): PmDoc {
  throw new Error('documentsService.assertContentJson 尚未实现');
}

export function getDocument(_db: Db, _id: string): Document {
  throw new Error('documentsService.getDocument 尚未实现');
}

export function replaceDocumentContent(
  _db: Db,
  _documentId: string,
  _contentJson: unknown,
  _options: ReplaceContentOptions = {},
): Document {
  throw new Error('documentsService.replaceDocumentContent 尚未实现');
}

export function getDocumentSummary(_db: Db, _id: string): DocumentSummary {
  throw new Error('documentsService.getDocumentSummary 尚未实现');
}
