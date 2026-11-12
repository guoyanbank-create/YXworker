/**
 * 图表服务（P2）：Mermaid 源码的 CRUD 与「图 ↔ 文档版本」绑定。
 *
 * 契约（docs/API_CONTRACT.md P2-5）：
 * - 新建/更新默认绑定当前工作 revision（versionName=null 表示当前工作版本）；
 * - 显式传 versionId 或调用 bind 时，绑定该命名版本的 revision + name；
 * - 服务端只保存 Mermaid 源码，不执行渲染；
 * - 本模块不自行 BEGIN/COMMIT 事务，需要多写的调用方用 `transaction(db, fn)` 包裹
 *   （删除图表会同步清理功能清单里的 diagramId 引用）。
 */
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { Diagram } from '../types.js';
import { getDocument } from './documentsService.js';
import { getProject } from './projectsService.js';
import { getVersion } from './versionsService.js';

/** 契约允许的 Mermaid 图表类型。 */
export const DIAGRAM_KINDS = [
  'flowchart',
  'architecture',
  'sequence',
  'class',
  'state',
] as const;

export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export interface CreateDiagramInput {
  title: string;
  source: string;
  kind?: DiagramKind;
  description?: string;
  chapterRef?: string | null;
  /** 不传：绑定当前文档 revision（versionName=null）。 */
  versionId?: string;
}

export interface UpdateDiagramInput {
  title?: string;
  source?: string;
  kind?: DiagramKind;
  description?: string;
  chapterRef?: string | null;
  /** 不传：重新绑定当前文档 revision；传：绑定该命名版本。 */
  versionId?: string;
}

interface DiagramRow {
  id: string;
  project_id: string;
  title: string;
  kind: string;
  source: string;
  description: string;
  document_id: string | null;
  document_revision: number | null;
  version_name: string | null;
  chapter_ref: string | null;
  created_at: string;
  updated_at: string;
}

const DIAGRAM_COLUMNS =
  'id, project_id, title, kind, source, description, document_id, document_revision, version_name, chapter_ref, created_at, updated_at';

function toDiagram(row: DiagramRow): Diagram {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind,
    source: row.source,
    description: row.description,
    documentId: row.document_id,
    documentRevision:
      row.document_revision === null ? null : Number(row.document_revision),
    versionName: row.version_name,
    chapterRef: row.chapter_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getDiagramRow(db: Db, id: string): DiagramRow {
  const row = db
    .prepare(`SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE id = ?`)
    .get(id) as unknown as DiagramRow | undefined;
  if (!row) throw notFound('not_found', `图表不存在: ${id}`);
  return row;
}

/** 图表列表（按 updatedAt 倒序；同一时刻写入用插入顺序倒序兜底）。 */
export function listDiagrams(db: Db, projectId: string): Diagram[] {
  // 项目不存在时 404，避免「空列表」掩盖错误。
  getProject(db, projectId);
  const rows = db
    .prepare(
      `SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC`,
    )
    .all(projectId) as unknown as DiagramRow[];
  return rows.map(toDiagram);
}

export function getDiagram(db: Db, id: string): Diagram {
  return toDiagram(getDiagramRow(db, id));
}

interface Binding {
  documentId: string;
  documentRevision: number;
  versionName: string | null;
}

/**
 * 解析绑定：versionId 必须属于该项目的文档；否则 404。
 * 不传 versionId 时绑定当前文档 revision、versionName=null。
 */
function resolveBinding(db: Db, projectId: string, versionId?: string): Binding {
  const project = getProject(db, projectId);
  if (versionId) {
    const version = getVersion(db, versionId);
    if (version.documentId !== project.documentId) {
      throw notFound('not_found', '版本不存在或不属于该项目的文档');
    }
    return {
      documentId: version.documentId,
      documentRevision: version.revision,
      versionName: version.name,
    };
  }
  const document = getDocument(db, project.documentId);
  return {
    documentId: document.id,
    documentRevision: document.revision,
    versionName: null,
  };
}

function normalizeChapterRef(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertKind(kind: string | undefined): DiagramKind {
  if (kind === undefined) return 'flowchart';
  if (!DIAGRAM_KINDS.includes(kind as DiagramKind)) {
    throw badRequest('validation_error', `不支持的图表类型: ${kind}`, {
      allowed: [...DIAGRAM_KINDS],
    });
  }
  return kind as DiagramKind;
}

/** 新建图表：默认绑定当前文档 revision；传 versionId 绑定命名版本。 */
export function createDiagram(
  db: Db,
  projectId: string,
  input: CreateDiagramInput,
): Diagram {
  const binding = resolveBinding(db, projectId, input.versionId);
  const at = nowIso();
  const id = newId('dia');
  db.prepare(
    `INSERT INTO diagrams (id, project_id, title, kind, source, description, document_id, document_revision, version_name, chapter_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    input.title.trim(),
    assertKind(input.kind),
    input.source,
    (input.description ?? '').trim(),
    binding.documentId,
    binding.documentRevision,
    binding.versionName,
    normalizeChapterRef(input.chapterRef),
    at,
    at,
  );
  return getDiagram(db, id);
}

/**
 * 更新图表：未传 versionId 时按契约重新绑定当前文档 revision；
 * 传 versionId 时绑定该命名版本。
 */
export function updateDiagram(
  db: Db,
  id: string,
  patch: UpdateDiagramInput,
): Diagram {
  const existing = getDiagramRow(db, id);
  const binding = resolveBinding(db, existing.project_id, patch.versionId);
  const next = {
    title: patch.title === undefined ? existing.title : patch.title.trim(),
    kind: patch.kind === undefined ? existing.kind : assertKind(patch.kind),
    source: patch.source === undefined ? existing.source : patch.source,
    description:
      patch.description === undefined ? existing.description : patch.description.trim(),
    chapterRef:
      patch.chapterRef === undefined
        ? existing.chapter_ref
        : normalizeChapterRef(patch.chapterRef),
  };
  db.prepare(
    `UPDATE diagrams SET title = ?, kind = ?, source = ?, description = ?, chapter_ref = ?,
       document_id = ?, document_revision = ?, version_name = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.title,
    next.kind,
    next.source,
    next.description,
    next.chapterRef,
    binding.documentId,
    binding.documentRevision,
    binding.versionName,
    nowIso(),
    id,
  );
  return getDiagram(db, id);
}

/** 显式绑定命名版本（versionId 必须属于该图表所在项目的文档）。 */
export function bindDiagram(db: Db, id: string, versionId: string): Diagram {
  const existing = getDiagramRow(db, id);
  const binding = resolveBinding(db, existing.project_id, versionId);
  db.prepare(
    `UPDATE diagrams SET document_id = ?, document_revision = ?, version_name = ?, updated_at = ?
     WHERE id = ?`,
  ).run(binding.documentId, binding.documentRevision, binding.versionName, nowIso(), id);
  return getDiagram(db, id);
}

/**
 * 删除图表，并清理功能清单中的 diagramId 引用（避免悬空外键）。
 * 调用方用 transaction 包裹两条写入。
 */
export function deleteDiagram(db: Db, id: string): void {
  getDiagramRow(db, id);
  db.prepare('DELETE FROM diagrams WHERE id = ?').run(id);
  db.prepare('UPDATE feature_specs SET diagram_id = NULL, updated_at = ? WHERE diagram_id = ?').run(
    nowIso(),
    id,
  );
}
