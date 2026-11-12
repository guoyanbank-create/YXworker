/** 引用资料路由：列表 + multipart/form-data 上传（字段名 `file`）+ P1 小节/定位检索。 */
import { Router, type Request } from 'express';
import Busboy from 'busboy';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import {
  DEFAULT_LOCATOR_LIMIT,
  createReference,
  getReference,
  getReferenceSection,
  listReferenceLocators,
  listReferences,
  listReferenceSections,
  MAX_REFERENCE_BYTES,
  MAX_LOCATOR_LIMIT,
  type UploadedReferenceFile,
} from '../services/referencesService.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

/** 从 multipart 请求中读取唯一的 `file` 字段（内存缓冲，10MB 上限）。 */
function readSingleFileUpload(req: Request): Promise<UploadedReferenceFile> {
  return new Promise((resolve, reject) => {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        // multipart 文件名按 UTF-8 解码（默认 latin1 会把中文文件名变成乱码）。
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: MAX_REFERENCE_BYTES, fields: 8, parts: 10 },
      });
    } catch {
      reject(badRequest('validation_error', '请求不是合法的 multipart/form-data 上传'));
      return;
    }

    let upload: UploadedReferenceFile | null = null;
    let sizeLimitHit = false;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (value: UploadedReferenceFile): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    busboy.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file' || upload) {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('limit', () => {
        sizeLimitHit = true;
      });
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.on('end', () => {
        upload = { filename: info.filename ?? '', buffer: Buffer.concat(chunks) };
      });
      stream.on('error', (error: Error) => fail(error));
    });

    busboy.on('error', () => fail(badRequest('validation_error', '上传数据解析失败')));
    busboy.on('finish', () => {
      if (sizeLimitHit) {
        fail(
          badRequest(
            'validation_error',
            `文件超过 ${MAX_REFERENCE_BYTES / (1024 * 1024)}MB 上限`,
            { maxBytes: MAX_REFERENCE_BYTES },
          ),
        );
        return;
      }
      if (!upload) {
        fail(badRequest('validation_error', '缺少上传文件（multipart 字段名应为 file）'));
        return;
      }
      succeed(upload);
    });

    req.pipe(busboy);
  });
}

function singleQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseLocatorQuery(req: Request): { q: string; limit: number } {
  const rawQuery = singleQueryValue(req.query.q);
  const q = (rawQuery ?? '').trim();
  if (q.length > 200) {
    throw badRequest('validation_error', '检索关键词过长（上限 200 字符）', { maxLength: 200 });
  }
  const rawLimit = singleQueryValue(req.query.limit);
  if (rawLimit !== undefined && rawLimit.trim().length > 0) {
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit) || Math.trunc(limit) !== limit) {
      throw badRequest('validation_error', 'limit 必须为整数', { limit: rawLimit });
    }
    if (limit < 1 || limit > MAX_LOCATOR_LIMIT) {
      throw badRequest('validation_error', `limit 取值范围为 1-${MAX_LOCATOR_LIMIT}`, {
        limit,
      });
    }
    return { q, limit: Math.trunc(limit) };
  }
  return { q, limit: DEFAULT_LOCATOR_LIMIT };
}

export function createReferencesRouter(deps: RouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/projects/:id/references', (req, res) => {
    res.json({ references: listReferences(db, req.params.id) });
  });

  router.post('/projects/:id/references', async (req, res, next) => {
    try {
      const projectId = req.params.id;
      // 先确认项目存在（404），避免为不存在的项目解析上传内容。
      listReferences(db, projectId);
      const file = await readSingleFileUpload(req);
      const reference = await createReference(db, projectId, file);
      res.status(201).json({ reference });
    } catch (error) {
      next(error);
    }
  });

  // P1：@ 检索（跨本项目全部引用的小节定位 + 摘录）。
  router.get('/projects/:id/references/locators', (req, res) => {
    const { q, limit } = parseLocatorQuery(req);
    const projectId = req.params.id;
    // listReferences 先确认项目存在（404），并触发旧数据小节补齐。
    listReferences(db, projectId);
    res.json({ results: listReferenceLocators(db, projectId, q, limit) });
  });

  // P1：某条引用的全部小节（按 paragraphIndex 升序；@ 选择器与来源弹窗）。
  router.get('/projects/:id/references/:refId/sections', (req, res) => {
    const { id, refId } = req.params;
    listReferences(db, id);
    const reference = getReference(db, refId);
    if (reference.projectId !== id) {
      // 不暴露其它项目的引用是否存在：统一 404（HttpError）。
      throw notFound('not_found', `引用资料不属于项目 ${id}: ${refId}`);
    }
    res.json({ reference, sections: listReferenceSections(db, refId) });
  });

  // P1：单个小节完整内容（“卡片可点开来源”）。
  router.get('/projects/:id/references/:refId/sections/:sectionId', (req, res) => {
    const { id, refId, sectionId } = req.params;
    listReferences(db, id);
    const reference = getReference(db, refId);
    if (reference.projectId !== id) {
      throw notFound('not_found', `引用资料不属于项目 ${id}: ${refId}`);
    }
    res.json({ reference, section: getReferenceSection(db, refId, sectionId) });
  });

  return router;
}
