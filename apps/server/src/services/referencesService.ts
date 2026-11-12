/**
 * 引用资料服务：上传 .docx/.md/.txt 并提取纯文本（只保存纯文本与摘要，不保存二进制）。
 *
 * P1：创建引用时用 domain/referenceSections.ts 自动切分小节/段落写入 reference_sections；
 * 读取时对旧数据（P0 种子/历史上传）做幂等补齐，保证 @ 定位、locator 检索与来源弹窗可用。
 *
 * 约定：本模块不自行 BEGIN/COMMIT；多写操作（引用 + 小节切分）用 `transaction(db, fn)` 辅助包裹。
 */
import { createRequire } from 'node:module';
import { basename, extname } from 'node:path';
import type { Db } from '../db.js';
import { newId, nowIso, transaction } from '../db.js';
import {
  parseReferenceSections,
  searchReferenceSections,
  type ParsedReferenceSection,
} from '../domain/referenceSections.js';
import { badRequest, notFound } from '../errors.js';
import { parseLocators } from '../llm/reference.js';
import type { ReferenceMaterial } from '../llm/types.js';
import type {
  Reference,
  ReferenceLocatorResult,
  ReferenceSection,
} from '../types.js';
import { getProject } from './projectsService.js';

// mammoth 无类型声明（CJS），用 createRequire 读取并显式给出最小类型面。
const require = createRequire(import.meta.url);
interface MammothLike {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
}
const mammoth = require('mammoth') as MammothLike;

/** 单个引用文件大小上限：10MB（与契约一致）。 */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_EXCERPT_LENGTH = 140;
/** @ 检索默认返回条数与上限（避免一次拉回全部小节）。 */
export const DEFAULT_LOCATOR_LIMIT = 20;
export const MAX_LOCATOR_LIMIT = 50;

const KIND_BY_EXTENSION: Record<string, Reference['kind']> = {
  '.docx': 'docx',
  '.md': 'md',
  '.txt': 'txt',
};

export interface UploadedReferenceFile {
  filename: string;
  buffer: Buffer;
}

interface ReferenceRow {
  id: string;
  project_id: string;
  title: string;
  kind: string;
  filename: string;
  char_count: number;
  excerpt: string;
  created_at: string;
  section_count?: number;
}

interface SectionRow {
  id: string;
  reference_id: string;
  locator: string;
  section_title: string;
  paragraph_index: number;
  excerpt: string;
  content: string;
  created_at: string;
}

const REFERENCE_COLUMNS = `r.id, r.project_id, r.title, r.kind, r.filename, r.char_count,
  r.excerpt, r.created_at,
  (SELECT COUNT(*) FROM reference_sections s WHERE s.reference_id = r.id) AS section_count`;

const SECTION_COLUMNS =
  's.id, s.reference_id, s.locator, s.section_title, s.paragraph_index, s.excerpt, s.content, s.created_at';

function toReference(row: ReferenceRow): Reference {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind as Reference['kind'],
    filename: row.filename,
    charCount: Number(row.char_count),
    excerpt: row.excerpt,
    sectionCount: Number(row.section_count ?? 0),
    createdAt: row.created_at,
  };
}

function toReferenceSection(row: SectionRow): ReferenceSection {
  return {
    id: row.id,
    referenceId: row.reference_id,
    locator: row.locator,
    sectionTitle: row.section_title,
    paragraphIndex: Number(row.paragraph_index),
    excerpt: row.excerpt,
    content: row.content,
    createdAt: row.created_at,
  };
}

function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT_LENGTH);
}

/** 纯文本归一化：统一换行、去掉 BOM 与行尾空白。 */
function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function titleFromFilename(filename: string): string {
  const base = basename(filename);
  const ext = extname(base);
  const stem = (ext ? base.slice(0, -ext.length) : base).trim();
  return stem.length > 0 ? stem.slice(0, 200) : '未命名资料';
}

/* ------------------------------------------------------------------ *
 * 小节切分 / 补齐（P1）
 * ------------------------------------------------------------------ */

/**
 * 把已切分的小节写入 reference_sections（调用方负责事务边界）。
 * 返回写入条数；正文为空时不写入。
 */
function writeReferenceSections(db: Db, referenceId: string, contentText: string): number {
  const parsed: ParsedReferenceSection[] = parseReferenceSections(contentText);
  const at = nowIso();
  for (const section of parsed) {
    db.prepare(
      `INSERT INTO reference_sections (id, reference_id, locator, section_title, paragraph_index, excerpt, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('rsec'),
      referenceId,
      section.locator,
      section.sectionTitle,
      section.paragraphIndex,
      section.excerpt,
      section.content,
      at,
    );
  }
  return parsed.length;
}

/**
 * 幂等补齐某条引用的小节（兼容 P0 已存在的引用数据）。
 * 已切分过的引用直接返回 0，不做重复写入。
 */
export function ensureReferenceSections(db: Db, referenceId: string): number {
  const reference = db
    .prepare('SELECT content_text FROM references_docs WHERE id = ?')
    .get(referenceId) as unknown as { content_text: string } | undefined;
  if (!reference) return 0;
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM reference_sections WHERE reference_id = ?')
    .get(referenceId) as { n: number };
  if (Number(count.n) > 0) return 0;
  return transaction(db, () => writeReferenceSections(db, referenceId, reference.content_text));
}

/** 幂等补齐某个项目下所有缺失小节的引用（读取列表/检索/生成前调用）。 */
export function ensureProjectReferenceSections(db: Db, projectId: string): number {
  const rows = db
    .prepare(
      `SELECT r.id FROM references_docs r
       WHERE r.project_id = ?
         AND NOT EXISTS (SELECT 1 FROM reference_sections s WHERE s.reference_id = r.id)
       ORDER BY r.created_at ASC, r.rowid ASC`,
    )
    .all(projectId) as unknown as Array<{ id: string }>;
  let inserted = 0;
  for (const row of rows) inserted += ensureReferenceSections(db, row.id);
  return inserted;
}

/* ------------------------------------------------------------------ *
 * 读取：列表 / 单条 / 小节 / 检索
 * ------------------------------------------------------------------ */

export function listReferences(db: Db, projectId: string): Reference[] {
  getProject(db, projectId);
  ensureProjectReferenceSections(db, projectId);
  const rows = db
    .prepare(
      `SELECT ${REFERENCE_COLUMNS} FROM references_docs r
       WHERE r.project_id = ? ORDER BY r.created_at ASC, r.rowid ASC`,
    )
    .all(projectId) as unknown as ReferenceRow[];
  return rows.map(toReference);
}

export function getReference(db: Db, id: string): Reference {
  // 读取即补齐：P0 历史引用在首次读取时获得小节数据，保证 @ 定位/来源打开可用。
  ensureReferenceSections(db, id);
  const row = db
    .prepare(`SELECT ${REFERENCE_COLUMNS} FROM references_docs r WHERE r.id = ?`)
    .get(id) as unknown as ReferenceRow | undefined;
  if (!row) throw notFound('not_found', `引用资料不存在: ${id}`);
  return toReference(row);
}

/** 某条引用的已切分小节（按 paragraphIndex 升序；@ 选择器与来源弹窗使用）。 */
export function listReferenceSections(db: Db, referenceId: string): ReferenceSection[] {
  getReference(db, referenceId);
  const rows = db
    .prepare(
      `SELECT ${SECTION_COLUMNS} FROM reference_sections s
       WHERE s.reference_id = ? ORDER BY s.paragraph_index ASC, s.rowid ASC`,
    )
    .all(referenceId) as unknown as SectionRow[];
  return rows.map(toReferenceSection);
}

/** 单个小节（来源打开）；不属于该引用时 404。 */
export function getReferenceSection(
  db: Db,
  referenceId: string,
  sectionId: string,
): ReferenceSection {
  getReference(db, referenceId);
  const row = db
    .prepare(
      `SELECT ${SECTION_COLUMNS} FROM reference_sections s
       WHERE s.id = ? AND s.reference_id = ?`,
    )
    .get(sectionId, referenceId) as unknown as SectionRow | undefined;
  if (!row) throw notFound('not_found', `引用小节不存在: ${sectionId}`);
  return toReferenceSection(row);
}

function clampLocatorLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LOCATOR_LIMIT;
  return Math.min(MAX_LOCATOR_LIMIT, Math.max(1, Math.trunc(limit)));
}

interface LocatorSearchRow {
  sectionId: string;
  referenceId: string;
  referenceTitle: string;
  locator: string;
  sectionTitle: string;
  excerpt: string;
  content: string;
}

/**
 * 跨项目全部引用检索 locator + excerpt（@ 输入框搜索）。
 * 空白查询按小节顺序返回前 limit 条，便于前端展示全部可选定位。
 */
export function listReferenceLocators(
  db: Db,
  projectId: string,
  query: string,
  limit?: number,
): ReferenceLocatorResult[] {
  getProject(db, projectId);
  ensureProjectReferenceSections(db, projectId);
  const rows = db
    .prepare(
      `SELECT s.id AS section_id, s.reference_id, s.locator, s.section_title, s.excerpt, s.content,
              r.title AS reference_title
       FROM reference_sections s
       JOIN references_docs r ON r.id = s.reference_id
       WHERE r.project_id = ?
       ORDER BY r.created_at ASC, r.rowid ASC, s.paragraph_index ASC, s.rowid ASC`,
    )
    .all(projectId) as unknown as Array<{
    section_id: string;
    reference_id: string;
    reference_title: string;
    locator: string;
    section_title: string;
    excerpt: string;
    content: string;
  }>;

  const candidates: LocatorSearchRow[] = rows.map((row) => ({
    sectionId: row.section_id,
    referenceId: row.reference_id,
    referenceTitle: row.reference_title,
    locator: row.locator,
    sectionTitle: row.section_title,
    excerpt: row.excerpt,
    content: row.content,
  }));
  return searchReferenceSections(candidates, query, clampLocatorLimit(limit)).map((hit) => ({
    referenceId: hit.referenceId,
    referenceTitle: hit.referenceTitle,
    sectionId: hit.sectionId,
    locator: hit.locator,
    excerpt: hit.excerpt,
  }));
}

/* ------------------------------------------------------------------ *
 * 生成/讨论的引用材料（P1：referenceIds / referenceSectionIds 过滤注入）
 * ------------------------------------------------------------------ */

export interface ReferenceSelectionInput {
  /** 只注入这些引用（须属于本项目）；未传=全部。 */
  referenceIds?: string[];
  /** 只注入这些小节（须属于本项目且在被选引用范围内）；未传=全部。 */
  referenceSectionIds?: string[];
}

interface ReferenceContentRow {
  id: string;
  title: string;
  content_text: string;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function dedupeIds(ids: string[] | undefined): string[] {
  return uniqueStrings((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
}

/**
 * 生成/讨论注入的引用材料（服务端内存结构，含正文；绝不返回给前端）：
 * - 未传过滤条件 → 全部引用（保持 P0 行为）；
 * - 仅 referenceIds → 这些引用的全文，locator 用其小节标题；
 * - 传 referenceSectionIds → 只注入选中的小节内容（带 `## locator` 结构，便于引用核验）；
 * - 两者同时传 → 小节必须落在所选引用范围内。
 *
 * 归属校验失败统一抛 HttpError 400 validation_error（不查询外部资源、不访问网络）。
 */
export function referenceMaterialsForProject(
  db: Db,
  projectId: string,
  selection: ReferenceSelectionInput = {},
): ReferenceMaterial[] {
  getProject(db, projectId);
  ensureProjectReferenceSections(db, projectId);

  const references = db
    .prepare(
      `SELECT id, title, content_text FROM references_docs
       WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectId) as unknown as ReferenceContentRow[];
  const sectionRows = db
    .prepare(
      `SELECT ${SECTION_COLUMNS} FROM reference_sections s
       JOIN references_docs r ON r.id = s.reference_id
       WHERE r.project_id = ?
       ORDER BY s.paragraph_index ASC, s.rowid ASC`,
    )
    .all(projectId) as unknown as SectionRow[];

  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const sectionsByReference = new Map<string, ReferenceSection[]>();
  for (const row of sectionRows) {
    const section = toReferenceSection(row);
    const list = sectionsByReference.get(section.referenceId) ?? [];
    list.push(section);
    sectionsByReference.set(section.referenceId, list);
  }

  const wantedReferenceIds = dedupeIds(selection.referenceIds);
  const wantedSectionIds = dedupeIds(selection.referenceSectionIds);
  const unknownReferenceIds = wantedReferenceIds.filter((id) => !referenceById.has(id));
  const sectionById = new Map(sectionRows.map((row) => [row.id, toReferenceSection(row)]));
  const unknownSectionIds = wantedSectionIds.filter((id) => !sectionById.has(id));
  if (unknownReferenceIds.length > 0 || unknownSectionIds.length > 0) {
    throw badRequest('validation_error', '所选引用/小节不属于本项目，不能注入提示词', {
      unknownReferenceIds,
      unknownReferenceSectionIds: unknownSectionIds,
    });
  }
  if (wantedReferenceIds.length > 0) {
    const outOfScope = wantedSectionIds.filter((id) => {
      const section = sectionById.get(id);
      return section !== undefined && !wantedReferenceIds.includes(section.referenceId);
    });
    if (outOfScope.length > 0) {
      throw badRequest('validation_error', '所选小节不属于所选的引用范围', {
        referenceSectionIds: outOfScope,
      });
    }
  }

  const wholeReferenceMaterial = (reference: ReferenceContentRow): ReferenceMaterial => {
    const sections = sectionsByReference.get(reference.id) ?? [];
    const locators = uniqueStrings(sections.map((section) => section.sectionTitle));
    return {
      id: reference.id,
      title: reference.title,
      content: reference.content_text,
      locators: locators.length > 0 ? locators : parseLocators(reference.content_text),
    };
  };

  // 只注入选中小节：保留 `## locator` 结构，引用核验（locator/excerpt）与来源打开一致。
  if (wantedSectionIds.length > 0) {
    const wantedRefSet =
      wantedReferenceIds.length > 0 ? new Set(wantedReferenceIds) : undefined;
    const grouped = new Map<string, ReferenceSection[]>();
    for (const sectionId of wantedSectionIds) {
      const section = sectionById.get(sectionId);
      if (!section) continue;
      if (wantedRefSet && !wantedRefSet.has(section.referenceId)) continue;
      const list = grouped.get(section.referenceId) ?? [];
      list.push(section);
      grouped.set(section.referenceId, list);
    }
    const materials: ReferenceMaterial[] = [];
    for (const reference of references) {
      const sections = grouped.get(reference.id);
      if (!sections || sections.length === 0) continue;
      const ordered = [...sections].sort(
        (left, right) => left.paragraphIndex - right.paragraphIndex,
      );
      materials.push({
        id: reference.id,
        title: reference.title,
        content: ordered.map((section) => `## ${section.locator}\n${section.content}`).join('\n\n'),
        locators: uniqueStrings(ordered.map((section) => section.locator)),
      });
    }
    return materials;
  }

  if (wantedReferenceIds.length > 0) {
    const wanted = new Set(wantedReferenceIds);
    return references
      .filter((reference) => wanted.has(reference.id))
      .map(wholeReferenceMaterial);
  }

  return references.map(wholeReferenceMaterial);
}

/* ------------------------------------------------------------------ *
 * 上传
 * ------------------------------------------------------------------ */

async function extractPlainText(kind: Reference['kind'], buffer: Buffer): Promise<string> {
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value ?? '';
  }
  return buffer.toString('utf8');
}

/**
 * 上传引用资料：校验项目/扩展名/大小，提取纯文本后保存（不保存二进制），
 * 同一事务内切分并写入 reference_sections（P1）。
 * 抛出 HttpError（validation_error / not_found）。
 */
export async function createReference(
  db: Db,
  projectId: string,
  file: UploadedReferenceFile,
): Promise<Reference> {
  getProject(db, projectId);
  const filename = basename(file.filename ?? '').trim();
  const extension = extname(filename).toLowerCase();
  const kind = KIND_BY_EXTENSION[extension];
  if (!kind) {
    throw badRequest('validation_error', '仅支持上传 .docx / .md / .txt 文件', {
      filename,
      supported: Object.keys(KIND_BY_EXTENSION),
    });
  }
  if (file.buffer.length > MAX_REFERENCE_BYTES) {
    throw badRequest(
      'validation_error',
      `文件超过 ${MAX_REFERENCE_BYTES / (1024 * 1024)}MB 上限`,
      { maxBytes: MAX_REFERENCE_BYTES, size: file.buffer.length },
    );
  }

  let text: string;
  try {
    text = normalizeText(await extractPlainText(kind, file.buffer));
  } catch {
    throw badRequest('validation_error', `无法解析 ${filename}，请确认文件未损坏`, { filename });
  }
  if (text.length === 0) {
    throw badRequest('validation_error', `未从 ${filename} 中提取到文本内容`, { filename });
  }

  const id = newId('ref');
  const at = nowIso();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO references_docs (id, project_id, title, kind, filename, content_text, char_count, excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      titleFromFilename(filename),
      kind,
      filename,
      text,
      text.length,
      excerptOf(text),
      at,
    );
    // 自动切分小节/段落：@ 定位、locator 检索、来源打开复用同一份数据。
    writeReferenceSections(db, id, text);
    return getReference(db, id);
  });
}
