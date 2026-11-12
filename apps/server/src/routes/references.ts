/** 引用资料路由：列表 + multipart/form-data 上传（字段名 `file`）。 */
import { Router, type Request } from 'express';
import Busboy from 'busboy';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import {
  createReference,
  listReferences,
  MAX_REFERENCE_BYTES,
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

  return router;
}
