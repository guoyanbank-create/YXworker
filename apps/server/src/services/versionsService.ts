/**
 * 版本服务：命名版本快照与回退。
 *
 * 约定：回退以版本内容生成新 revision（不删除历史），复用 documentsService 的权威写入；
 * 本模块不自行 BEGIN/COMMIT 事务，调用方（路由层）可用 transaction 包裹。
 */
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Document, Version } from '../types.js';
import { getDocument, getDocumentSummary, replaceDocumentContent } from './documentsService.js';

interface VersionRow {
  id: string;
  document_id: string;
  name: string;
  revision: number;
  content_json: string;
  created_at: string;
  created_by: string;
}

const VERSION_COLUMNS = 'id, document_id, name, revision, content_json, created_at, created_by';

function toVersion(row: VersionRow): Version {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    revision: Number(row.revision),
    createdAt: row.created_at,
    createdBy: row.created_by,
    contentJson: JSON.parse(row.content_json) as unknown,
  };
}

/** 版本列表（按创建时间升序；同一毫秒写入时用插入顺序兜底）。 */
export function listVersions(db: Db, documentId: string): Version[] {
  // 文档不存在时返回 404，避免“空版本列表”掩盖错误。
  getDocumentSummary(db, documentId);
  const rows = db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM versions WHERE document_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(documentId) as unknown as VersionRow[];
  return rows.map(toVersion);
}

export function getVersion(db: Db, versionId: string): Version {
  const row = db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM versions WHERE id = ?`)
    .get(versionId) as unknown as VersionRow | undefined;
  if (!row) throw notFound('not_found', `版本不存在: ${versionId}`);
  return toVersion(row);
}

/** 创建命名版本（名称在同一文档内唯一），保存当前 revision 的内容快照。 */
export function createVersion(
  db: Db,
  documentId: string,
  name: string,
  createdBy = 'user',
): Version {
  const document = getDocument(db, documentId);
  const trimmed = name.trim();
  if (trimmed.length === 0) throw badRequest('validation_error', '版本名称不能为空');
  if (trimmed.length > 100) throw badRequest('validation_error', '版本名称不能超过 100 个字符');
  const duplicate = db
    .prepare('SELECT id FROM versions WHERE document_id = ? AND name = ?')
    .get(documentId, trimmed) as unknown as { id: string } | undefined;
  if (duplicate) {
    throw conflict('version_conflict', `版本名称已存在: ${trimmed}`, { name: trimmed });
  }
  const id = newId('ver');
  db.prepare(
    `INSERT INTO versions (id, document_id, name, revision, content_json, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    documentId,
    trimmed,
    document.revision,
    JSON.stringify(document.contentJson),
    nowIso(),
    createdBy,
  );
  return getVersion(db, id);
}

/** 回退到指定版本：以该版本内容生成新 revision，历史版本保留。 */
export function restoreVersion(db: Db, versionId: string): Document {
  const version = getVersion(db, versionId);
  return replaceDocumentContent(db, version.documentId, version.contentJson, {
    actor: 'restore',
    reason: `restore ${version.name}`,
  });
}
