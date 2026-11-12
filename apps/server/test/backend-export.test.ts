/**
 * DOCX 导出 API 测试：默认导出/指定版本导出，校验 zip 合法性、document.xml 内容与格式。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Version } from '../src/types.js';
import { looksLikeZip, readZipEntries } from './backend-zip.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface DocumentResponse {
  document: Document;
}
interface VersionsResponse {
  versions: Version[];
}
interface ProjectResponse {
  project: { id: string; documentId: string };
}
interface ErrorResponse {
  error: { code: string; message: string };
}

interface DownloadResult {
  status: number;
  contentType: string | null;
  disposition: string | null;
  buffer: Buffer;
}

describe('DOCX 导出 API', () => {
  let ctx: TestContext;
  let server: TestServer;
  let baseUrl: string;
  let originalVersionId = '';

  beforeAll(async () => {
    ctx = makeTestContext();
    server = await startTestServer(ctx.app);
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    ctx.db.close();
  });

  async function download(path: string): Promise<DownloadResult> {
    const response = await fetch(`${baseUrl}${path}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      buffer,
    };
  }

  function documentXml(buffer: Buffer): string {
    const entry = readZipEntries(buffer).find((item) => item.name === 'word/document.xml');
    expect(entry).toBeDefined();
    return entry!.data.toString('utf8');
  }

  async function fetchDocument(): Promise<Document> {
    const res = await api<DocumentResponse>(baseUrl, `/api/documents/${ctx.documentId}`);
    expect(res.status).toBe(200);
    return res.body.document;
  }

  it('默认导出当前文档为合法 DOCX，正文可见且文件名包含标题', async () => {
    const download1 = await download(`/api/documents/${ctx.documentId}/export.docx`);
    expect(download1.status).toBe(200);
    expect(download1.contentType).toBe(DOCX_MIME);
    expect(download1.disposition).toContain('attachment');
    expect(download1.disposition).toContain("filename*=UTF-8''");
    const encodedName = download1.disposition!.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encodedName)).toContain('.docx');
    expect(decodeURIComponent(encodedName)).toContain('方案');
    expect(looksLikeZip(download1.buffer)).toBe(true);

    const entries = readZipEntries(download1.buffer).map((entry) => entry.name);
    expect(entries).toContain('[Content_Types].xml');
    expect(entries).toContain('word/document.xml');
    expect(entries).toContain('word/styles.xml');

    const xml = documentXml(download1.buffer);
    expect(xml).toContain('第一章 项目背景与目标');
    expect(xml).toContain('政务服务热线');
    expect(xml).toContain('Heading1');
  });

  it('导出保留标题层级/对齐/粗斜下划线/列表/引用格式', async () => {
    const before = await fetchDocument();
    // 先把改动前的内容存成命名版本，供后续版本导出断言使用。
    const versionRes = await jsonApi<{ version: Version }>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/versions`,
      { name: 'V-original' },
    );
    expect(versionRes.status).toBe(201);
    originalVersionId = versionRes.body.version.id;

    const customContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, paragraphId: 'h1' },
          content: [{ type: 'text', text: '第二章 自定义导出标题' }],
        },
        {
          type: 'paragraph',
          attrs: { paragraphId: 'p1', textAlign: 'center' },
          content: [{ type: 'text', text: '居中段落文本' }],
        },
        {
          type: 'paragraph',
          attrs: { paragraphId: 'p2' },
          content: [
            { type: 'text', text: '加粗文本', marks: [{ type: 'bold' }] },
            { type: 'text', text: '斜体文本', marks: [{ type: 'italic' }] },
            { type: 'text', text: '下划线文本', marks: [{ type: 'underline' }] },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  attrs: { paragraphId: 'li1' },
                  content: [{ type: 'text', text: '无序列表条目' }],
                },
              ],
            },
          ],
        },
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  attrs: { paragraphId: 'oi1' },
                  content: [{ type: 'text', text: '有序列表条目' }],
                },
              ],
            },
          ],
        },
        {
          type: 'blockquote',
          attrs: { paragraphId: 'q1' },
          content: [
            {
              type: 'paragraph',
              attrs: { paragraphId: 'q1' },
              content: [{ type: 'text', text: '引用块文本' }],
            },
          ],
        },
      ],
    };
    const saved = await jsonApi<{ document: Document }>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: customContent, baseRevision: before.revision },
    );
    expect(saved.status).toBe(200);

    const downloadRes = await download(`/api/documents/${ctx.documentId}/export.docx`);
    expect(downloadRes.status).toBe(200);
    const xml = documentXml(downloadRes.buffer);
    expect(xml).toContain('第二章 自定义导出标题');
    expect(xml).toContain('Heading2');
    expect(xml).toContain('居中段落文本');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('加粗文本');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:u ');
    expect(xml).toContain('无序列表条目');
    expect(xml).toContain('有序列表条目');
    expect(xml).toContain('引用块文本');
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:ind ');
    // 列表缩进/引用缩进来自 paragraph 属性。
    expect(xml).toMatch(/<w:ind[^>]*w:left="720"/);
  });

  it('新建项目的空白文档（无版本时）也能导出合法 DOCX', async () => {
    const created = await jsonApi<ProjectResponse>(baseUrl, 'POST', '/api/projects', {
      name: '空白导出项目',
    });
    expect(created.status).toBe(201);
    const blank = await download(
      `/api/documents/${created.body.project.documentId}/export.docx`,
    );
    expect(blank.status).toBe(200);
    expect(blank.contentType).toBe(DOCX_MIME);
    expect(looksLikeZip(blank.buffer)).toBe(true);
    const xml = documentXml(blank.buffer);
    expect(xml).toContain('<w:document');
    expect(xml).toContain('<w:body>');
  });

  it('?versionId 导出历史版本快照（不含当前改动）', async () => {
    expect(originalVersionId).not.toBe('');
    const versionDownload = await download(
      `/api/documents/${ctx.documentId}/export.docx?versionId=${originalVersionId}`,
    );
    expect(versionDownload.status).toBe(200);
    const versionXml = documentXml(versionDownload.buffer);
    expect(versionXml).toContain('第一章 项目背景与目标');
    expect(versionXml).toContain('政务服务热线');
    expect(versionXml).not.toContain('第二章 自定义导出标题');

    // 不传 versionId 导出当前（已修改）文档。
    const currentDownload = await download(`/api/documents/${ctx.documentId}/export.docx`);
    const currentXml = documentXml(currentDownload.buffer);
    expect(currentXml).toContain('第二章 自定义导出标题');
    expect(currentXml).not.toContain('政务服务热线');
  });

  it('versionId 不属于该文档 / 不存在 / 文档不存在时返回 404', async () => {
    const otherProject = await jsonApi<ProjectResponse>(baseUrl, 'POST', '/api/projects', {
      name: '另一个文档',
    });
    expect(otherProject.status).toBe(201);
    const otherVersions = await api<VersionsResponse>(
      baseUrl,
      `/api/documents/${otherProject.body.project.documentId}/versions`,
    );
    const otherVersionId = otherVersions.body.versions[0].id;

    const crossDoc = await download(
      `/api/documents/${ctx.documentId}/export.docx?versionId=${otherVersionId}`,
    );
    expect(crossDoc.status).toBe(404);
    expect(JSON.parse(crossDoc.buffer.toString('utf8')).error.code).toBe('not_found');

    const missingVersion = await download(
      `/api/documents/${ctx.documentId}/export.docx?versionId=ver_not_exist`,
    );
    expect(missingVersion.status).toBe(404);

    const missingDoc = await download('/api/documents/doc_not_exist/export.docx');
    expect(missingDoc.status).toBe(404);
    expect(JSON.parse(missingDoc.buffer.toString('utf8')).error.code).toBe('not_found');
  });
});
