/**
 * 功能清单服务（P2 FeatureSpec）：项目功能条目的 CRUD。
 *
 * 契约（docs/API_CONTRACT.md P2-6）：
 * - status ∈ planned|in_progress|done|dropped，priority ∈ P0|P1|P2；
 * - chapterRef/diagramId 用于 ImpactPlan 关联（diagramId 必须属于同项目）；
 * - 本模块不自行 BEGIN/COMMIT 事务，调用方按需用 `transaction(db, fn)` 包裹。
 */
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { FeatureSpec, FeatureStatus } from '../types.js';
import { getDiagram } from './diagramsService.js';
import { getProject } from './projectsService.js';

export const FEATURE_STATUSES = ['planned', 'in_progress', 'done', 'dropped'] as const;
export const FEATURE_PRIORITIES = ['P0', 'P1', 'P2'] as const;

export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];

export interface CreateFeatureInput {
  title: string;
  description?: string;
  status?: FeatureStatus;
  priority?: FeaturePriority;
  chapterRef?: string | null;
  diagramId?: string | null;
}

export interface UpdateFeatureInput {
  title?: string;
  description?: string;
  status?: FeatureStatus;
  priority?: FeaturePriority;
  chapterRef?: string | null;
  diagramId?: string | null;
}

interface FeatureRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  chapter_ref: string | null;
  diagram_id: string | null;
  created_at: string;
  updated_at: string;
}

const FEATURE_COLUMNS =
  'id, project_id, title, description, status, priority, chapter_ref, diagram_id, created_at, updated_at';

function toFeature(row: FeatureRow): FeatureSpec {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as FeatureStatus,
    priority: row.priority as FeatureSpec['priority'],
    chapterRef: row.chapter_ref,
    diagramId: row.diagram_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getFeatureRow(db: Db, id: string): FeatureRow {
  const row = db
    .prepare(`SELECT ${FEATURE_COLUMNS} FROM feature_specs WHERE id = ?`)
    .get(id) as unknown as FeatureRow | undefined;
  if (!row) throw notFound('not_found', `功能条目不存在: ${id}`);
  return row;
}

/** 功能清单（按创建时间升序，保持种子/人工录入顺序）。 */
export function listFeatures(db: Db, projectId: string): FeatureSpec[] {
  getProject(db, projectId); // 项目不存在时 404
  const rows = db
    .prepare(
      `SELECT ${FEATURE_COLUMNS} FROM feature_specs WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectId) as unknown as FeatureRow[];
  return rows.map(toFeature);
}

export function getFeature(db: Db, id: string): FeatureSpec {
  return toFeature(getFeatureRow(db, id));
}

function normalizeRef(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** diagramId 若指定，必须是本项目内的图表，避免跨项目引用。 */
function assertDiagramInProject(
  db: Db,
  projectId: string,
  diagramId: string | null | undefined,
): string | null {
  const normalized = normalizeRef(diagramId);
  if (normalized === null) return null;
  const diagram = getDiagram(db, normalized);
  if (diagram.projectId !== projectId) {
    throw notFound('not_found', '图表不存在或不属于该项目');
  }
  return normalized;
}

/** 新建功能条目：status 默认 planned，priority 默认 P1。 */
export function createFeature(
  db: Db,
  projectId: string,
  input: CreateFeatureInput,
): FeatureSpec {
  getProject(db, projectId);
  const at = nowIso();
  const id = newId('feat');
  db.prepare(
    `INSERT INTO feature_specs (id, project_id, title, description, status, priority, chapter_ref, diagram_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    input.title.trim(),
    (input.description ?? '').trim(),
    input.status ?? 'planned',
    input.priority ?? 'P1',
    normalizeRef(input.chapterRef),
    assertDiagramInProject(db, projectId, input.diagramId),
    at,
    at,
  );
  return getFeature(db, id);
}

/** 局部更新功能条目（PATCH 语义：未提供的字段保持不变）。 */
export function updateFeature(
  db: Db,
  id: string,
  patch: UpdateFeatureInput,
): FeatureSpec {
  const existing = getFeatureRow(db, id);
  const diagramId =
    patch.diagramId === undefined
      ? existing.diagram_id
      : assertDiagramInProject(db, existing.project_id, patch.diagramId);
  db.prepare(
    `UPDATE feature_specs SET title = ?, description = ?, status = ?, priority = ?,
       chapter_ref = ?, diagram_id = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.title === undefined ? existing.title : patch.title.trim(),
    patch.description === undefined ? existing.description : patch.description.trim(),
    patch.status ?? existing.status,
    patch.priority ?? existing.priority,
    patch.chapterRef === undefined ? existing.chapter_ref : normalizeRef(patch.chapterRef),
    diagramId,
    nowIso(),
    id,
  );
  return getFeature(db, id);
}

export function deleteFeature(db: Db, id: string): void {
  getFeatureRow(db, id);
  db.prepare('DELETE FROM feature_specs WHERE id = ?').run(id);
}
