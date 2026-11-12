/**
 * 引用资料服务：上传 .docx/.md/.txt 并提取纯文本（只保存纯文本与摘要，不保存二进制）。
 *
 * 约定：本模块不自行 BEGIN/COMMIT 事务（单条写入，无需事务）。
 */
import { createRequire } from 'node:module';
import { basename, extname } from 'node:path';
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { Reference } from '../types.js';
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
}

const REFERENCE_COLUMNS =
  'id, project_id, title, kind, filename, char_count, excerpt, created_at';

function toReference(row: ReferenceRow): Reference {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind as Reference['kind'],
    filename: row.filename,
    charCount: Number(row.char_count),
    excerpt: row.excerpt,
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

export function listReferences(db: Db, projectId: string): Reference[] {
  getProject(db, projectId);
  const rows = db
    .prepare(
      `SELECT ${REFERENCE_COLUMNS} FROM references_docs WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectId) as unknown as ReferenceRow[];
  return rows.map(toReference);
}

export function getReference(db: Db, id: string): Reference {
  const row = db
    .prepare(`SELECT ${REFERENCE_COLUMNS} FROM references_docs WHERE id = ?`)
    .get(id) as unknown as ReferenceRow | undefined;
  if (!row) throw notFound('not_found', `引用资料不存在: ${id}`);
  return toReference(row);
}

async function extractPlainText(kind: Reference['kind'], buffer: Buffer): Promise<string> {
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value ?? '';
  }
  return buffer.toString('utf8');
}

/**
 * 上传引用资料：校验项目/扩展名/大小，提取纯文本后保存（不保存二进制）。
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
    nowIso(),
  );
  return getReference(db, id);
}
