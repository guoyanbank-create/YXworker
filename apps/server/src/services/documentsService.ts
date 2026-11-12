/**
 * 文档服务：TipTap JSON 正文的权威读写。
 *
 * 关键约束（对应 docs/API_CONTRACT.md §3 与 docs/ARCHITECTURE.md §3）：
 * - `documents.content_json` 是正文唯一可信源，服务端从 JSON 派生段落块；
 * - 本模块不自行 BEGIN/COMMIT 事务，需要多写操作（文档 + 提案冲突标记）的调用方用
 *   `transaction(db, fn)` 包裹；
 * - 保存不改写调用方传入对象的语义：校验后返回规范化后的 JSON 副本（缺失 paragraphId 的
 *   段落块补 `auto_<index>` 兜底 id），并由调用方持久化。
 */
import { z } from 'zod';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { PmDoc, PmNode } from '../domain/paragraphs.js';
import { extractParagraphs } from '../domain/paragraphs.js';
import { badRequest, notFound } from '../errors.js';
import type { Document, DocumentSummary } from '../types.js';

export interface ReplaceContentOptions {
  actor?: string;
  reason?: string;
}

interface DocumentRow {
  id: string;
  project_id: string;
  title: string;
  content_json: string;
  revision: number;
  updated_at: string;
}

const DOCUMENT_COLUMNS = 'id, project_id, title, content_json, revision, updated_at';

const nodeSchema: z.ZodType<PmNode> = z.lazy(() =>
  z.looseObject({
    type: z.string().min(1),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(z.unknown()).optional(),
    content: z.array(nodeSchema).optional(),
  }),
);

const docSchema = z.looseObject({
  type: z.literal('doc'),
  content: z.array(nodeSchema),
});

function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    message: issue.message,
  }));
}

/**
 * 校验 `{ type: "doc", content: [...] }` 结构并返回规范化副本：
 * 段落/标题/列表项/引用块缺失 `paragraphId` 时补 `auto_<index>` 兜底 id
 * （与 extractParagraphs 的兜底顺序一致，便于后续按 id 定位与提案锚定）。
 */
export function assertContentJson(contentJson: unknown): PmDoc {
  const parsed = docSchema.safeParse(contentJson);
  if (!parsed.success) {
    throw badRequest(
      'validation_error',
      'contentJson 必须是合法的 TipTap 文档（{ type: "doc", content: [...] }）',
      { issues: formatIssues(parsed.error) },
    );
  }
  const doc = parsed.data as PmDoc;
  normalizeParagraphIds(doc);
  return doc;
}

/**
 * 按与 extractParagraphs 相同的遍历顺序补全 paragraphId。
 * 只遍历会产生段落块的容器（顶层块、引用块内部段落、列表项内部段落），
 * 表格等未处理节点不会产生锚点，保持与派生结果一一对应。
 */
function normalizeParagraphIds(doc: PmDoc): void {
  let seq = 0;
  const ensure = (node: PmNode | undefined): void => {
    if (!node) return;
    const attrs = node.attrs ?? (node.attrs = {});
    const existing = attrs.paragraphId;
    if (typeof existing !== 'string' || existing.length === 0) {
      attrs.paragraphId = `auto_${seq}`;
    }
    seq += 1;
  };
  const visit = (node: PmNode | undefined): void => {
    if (!node) return;
    if (node.type === 'heading' || node.type === 'paragraph') {
      ensure(node);
      return;
    }
    if (node.type === 'blockquote') {
      const inner = (node.content ?? []).filter((child) => child.type === 'paragraph');
      if (inner.length <= 1) {
        ensure(inner[0] ?? node);
      } else {
        inner.forEach(ensure);
      }
      return;
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      for (const item of node.content ?? []) {
        if (item.type !== 'listItem') continue;
        for (const child of item.content ?? []) {
          if (child.type === 'paragraph') ensure(child);
        }
      }
    }
  };
  for (const node of doc.content) visit(node);
}

function getDocumentRow(db: Db, id: string): DocumentRow {
  const row = db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`)
    .get(id) as unknown as DocumentRow | undefined;
  if (!row) throw notFound('not_found', `文档不存在: ${id}`);
  return row;
}

function toDocument(row: DocumentRow): Document {
  const contentJson = JSON.parse(row.content_json) as unknown;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    revision: Number(row.revision),
    contentJson,
    paragraphs: extractParagraphs(contentJson),
    updatedAt: row.updated_at,
  };
}

/** 读取完整文档（含服务端派生段落块）；不存在时 404。 */
export function getDocument(db: Db, id: string): Document {
  return toDocument(getDocumentRow(db, id));
}

/** 文档摘要（列表/项目详情用）；不存在时 404。 */
export function getDocumentSummary(db: Db, id: string): DocumentSummary {
  const row = getDocumentRow(db, id);
  const contentJson = JSON.parse(row.content_json) as unknown;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    revision: Number(row.revision),
    paragraphCount: extractParagraphs(contentJson).length,
    updatedAt: row.updated_at,
  };
}

/**
 * 用新的 TipTap JSON 覆盖文档正文：校验结构、revision + 1、刷新 updated_at，
 * 返回最新 Document（含重新派生的段落块）。
 *
 * 注意：乐观锁（baseRevision）由调用方在事务内先行比对；本函数只负责写入。
 */
export function replaceDocumentContent(
  db: Db,
  documentId: string,
  contentJson: unknown,
  _options: ReplaceContentOptions = {},
): Document {
  getDocumentRow(db, documentId);
  const doc = assertContentJson(contentJson);
  const at = nowIso();
  db.prepare(
    'UPDATE documents SET content_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(doc), at, documentId);
  return getDocument(db, documentId);
}
