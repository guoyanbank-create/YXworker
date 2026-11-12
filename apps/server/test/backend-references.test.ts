/**
 * 引用资料 API 测试：种子引用读取、multipart 上传 .txt/.md/.docx、大小与类型校验。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Document as DocxDocument, Packer, Paragraph, TextRun } from 'docx';
import { MAX_REFERENCE_BYTES, createReference } from '../src/services/referencesService.js';
import type { Reference } from '../src/types.js';
import {
  api,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

interface ReferencesResponse {
  references: Reference[];
}
interface ReferenceResponse {
  reference: Reference;
}
interface ErrorResponse {
  error: { code: string; message: string; details?: { maxBytes?: number } };
}

function fileForm(content: Buffer, filename: string, type: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(content)], { type }), filename);
  return form;
}

describe('引用资料 API', () => {
  let ctx: TestContext;
  let server: TestServer;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = makeTestContext();
    server = await startTestServer(ctx.app);
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    ctx.db.close();
  });

  async function fetchReferences(projectId = ctx.projectId): Promise<Reference[]> {
    const res = await api<ReferencesResponse>(
      baseUrl,
      `/api/projects/${projectId}/references`,
    );
    expect(res.status).toBe(200);
    return res.body.references;
  }

  it('GET /api/projects/:id/references 返回种子引用', async () => {
    const references = await fetchReferences();
    expect(references.length).toBeGreaterThanOrEqual(2);
    expect(references.every((reference) => reference.projectId === ctx.projectId)).toBe(true);
    expect(references.some((reference) => reference.kind === 'md')).toBe(true);
    for (const reference of references) {
      expect(reference.charCount).toBeGreaterThan(0);
      expect(reference.excerpt.length).toBeLessThanOrEqual(140);
      expect(reference.title.length).toBeGreaterThan(0);
    }
  });

  it('POST 上传 .txt：提取纯文本、标题取文件名、保存摘要', async () => {
    const text = '本文件用于验证引用资料上传。\n第二行：包含中文与 English 混排。';
    const res = await api<ReferenceResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      { method: 'POST', body: fileForm(Buffer.from(text, 'utf8'), 'meeting-notes.txt', 'text/plain') },
    );
    expect(res.status).toBe(201);
    const reference = res.body.reference;
    expect(reference.id).toMatch(/^ref_/);
    expect(reference.projectId).toBe(ctx.projectId);
    expect(reference.kind).toBe('txt');
    expect(reference.filename).toBe('meeting-notes.txt');
    expect(reference.title).toBe('meeting-notes');
    expect(reference.charCount).toBe(text.length);
    expect(reference.excerpt).toContain('引用资料上传');
    expect(reference.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const stored = ctx.db
      .prepare('SELECT content_text FROM references_docs WHERE id = ?')
      .get(reference.id) as unknown as { content_text: string };
    expect(stored.content_text).toBe(text);

    const references = await fetchReferences();
    expect(references.map((item) => item.id)).toContain(reference.id);
  });

  it('POST 上传 .md 文件可用', async () => {
    const markdown = '# 技术说明\n\n## 第 1 节 检索链路\n关键词召回 + 向量召回。';
    const res = await api<ReferenceResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      { method: 'POST', body: fileForm(Buffer.from(markdown, 'utf8'), 'tech-notes.md', 'text/markdown') },
    );
    expect(res.status).toBe(201);
    expect(res.body.reference.kind).toBe('md');
    expect(res.body.reference.title).toBe('tech-notes');
    expect(res.body.reference.charCount).toBe(markdown.length);
  });

  it('POST 上传 .docx：用 mammoth 提取纯文本', async () => {
    const docx = new DocxDocument({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun('DOCX 提取测试标题')] }),
            new Paragraph({ children: [new TextRun('正文第一段：用于验证 mammoth 提取。')] }),
          ],
        },
      ],
    });
    const buffer = await Packer.toBuffer(docx);
    const res = await api<ReferenceResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      {
        method: 'POST',
        body: fileForm(
          buffer,
          '历史方案.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.reference.kind).toBe('docx');
    expect(res.body.reference.title).toBe('历史方案');
    const stored = ctx.db
      .prepare('SELECT content_text FROM references_docs WHERE id = ?')
      .get(res.body.reference.id) as unknown as { content_text: string };
    expect(stored.content_text).toContain('DOCX 提取测试标题');
    expect(stored.content_text).toContain('正文第一段');
  });

  it('损坏的 .docx 返回 400 validation_error（而非 500）', async () => {
    const res = await api<ErrorResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      {
        method: 'POST',
        body: fileForm(
          Buffer.from('this is not a real docx zip'),
          'broken.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('不支持的文件类型返回 400 validation_error', async () => {
    const res = await api<ErrorResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      { method: 'POST', body: fileForm(Buffer.from('%PDF-1.4'), 'scan.pdf', 'application/pdf') },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('缺少 multipart 字段 file 返回 400 validation_error', async () => {
    const form = new FormData();
    form.append('other', 'value');
    const res = await api<ErrorResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      { method: 'POST', body: form },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('空文本文件返回 400 validation_error', async () => {
    const res = await api<ErrorResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      { method: 'POST', body: fileForm(Buffer.from('   \n\n  ', 'utf8'), 'empty.txt', 'text/plain') },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('超过 10MB 上限被拒绝（服务层单元校验）', async () => {
    await expect(
      createReference(ctx.db, ctx.projectId, {
        filename: 'too-large.txt',
        buffer: Buffer.alloc(MAX_REFERENCE_BYTES + 1, 0x61),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_error' });
  });

  it('不存在的项目返回 404 not_found', async () => {
    const list = await api<ErrorResponse>(baseUrl, '/api/projects/prj_not_exist/references');
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe('not_found');

    const upload = await api<ErrorResponse>(baseUrl, '/api/projects/prj_not_exist/references', {
      method: 'POST',
      body: fileForm(Buffer.from('hello'), 'a.txt', 'text/plain'),
    });
    expect(upload.status).toBe(404);
    expect(upload.body.error.code).toBe('not_found');
  });
});
