/**
 * 项目服务：项目的创建/读取/更新，以及创建项目时自动创建的空白文档与 V1.0 版本。
 *
 * 约定：本模块不自行 BEGIN/COMMIT 事务；创建项目涉及多条写入，调用方用 `transaction(db, fn)` 包裹。
 */
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { PmDoc } from '../domain/paragraphs.js';
import type { DataLevel, Project } from '../types.js';

export interface CreateProjectInput {
  name: string;
  description?: string;
  dataLevel?: DataLevel;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  dataLevel?: DataLevel;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  data_level: string;
  document_id: string;
  created_at: string;
  updated_at: string;
}

const PROJECT_COLUMNS = 'id, name, description, data_level, document_id, created_at, updated_at';

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    dataLevel: row.data_level as DataLevel,
    documentId: row.document_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 空白文档：保留一个空段落，方便编辑器直接输入。 */
export function blankContentJson(): PmDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { paragraphId: 'p_001' } }],
  };
}

export function listProjects(db: Db): Project[] {
  const rows = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at ASC, rowid ASC`)
    .all() as unknown as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(db: Db, id: string): Project {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
    .get(id) as unknown as ProjectRow | undefined;
  if (!row) throw notFound('not_found', `项目不存在: ${id}`);
  return toProject(row);
}

/**
 * 创建项目：同一事务内创建项目、空白文档（标题 `<name> 方案（V1.0）`，revision=1）与 V1.0 版本。
 * 调用方需用 transaction 包裹（见 routes/projects.ts）。
 */
export function createProject(db: Db, input: CreateProjectInput): Project {
  const name = input.name.trim();
  if (name.length === 0) throw badRequest('validation_error', '项目名称不能为空');
  const description = (input.description ?? '').trim();
  const dataLevel: DataLevel = input.dataLevel ?? 'internal';
  const at = nowIso();
  const projectId = newId('prj');
  const documentId = newId('doc');
  const title = `${name} 方案（V1.0）`;
  const contentJson = blankContentJson();
  const contentText = JSON.stringify(contentJson);

  db.prepare(
    `INSERT INTO projects (id, name, description, data_level, document_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, name, description, dataLevel, documentId, at, at);

  db.prepare(
    `INSERT INTO documents (id, project_id, title, content_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(documentId, projectId, title, contentText, at, at);

  db.prepare(
    `INSERT INTO versions (id, document_id, name, revision, content_json, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('ver'), documentId, 'V1.0', 1, contentText, at, 'system');

  return getProject(db, projectId);
}

/** 更新项目元数据（P0 仅用于数据分级演示）。 */
export function updateProject(db: Db, id: string, patch: UpdateProjectInput): Project {
  const current = getProject(db, id);
  const name = patch.name === undefined ? current.name : patch.name.trim();
  if (name.length === 0) throw badRequest('validation_error', '项目名称不能为空');
  const description = patch.description === undefined ? current.description : patch.description.trim();
  const dataLevel = patch.dataLevel ?? current.dataLevel;
  const at = nowIso();
  db.prepare(
    'UPDATE projects SET name = ?, description = ?, data_level = ?, updated_at = ? WHERE id = ?',
  ).run(name, description, dataLevel, at, id);
  return getProject(db, id);
}
