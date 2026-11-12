/**
 * P2 Word 模板 API 测试（API_CONTRACT P2-8）：
 * `GET /api/templates` 与 `?template=gov|tech` 导出版式（zip + document.xml 断言），
 * 并验证模板只改版式、不改正文内容。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { looksLikeZip, readZipEntries } from './backend-zip.js';
import {
  api,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface TemplateInfo {
  id: 'gov' | 'tech';
  name: string;
  description: string;
}
interface TemplatesResponse {
  templates: TemplateInfo[];
}
interface ErrorResponse {
  error: { code: string; message: string };
}

describe('P2 Word 模板与导出 API', () => {
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

  async function download(path: string) {
    const response = await fetch(`${baseUrl}${path}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      buffer,
    };
  }

  function documentXml(buffer: Buffer): string {
    const entry = readZipEntries(buffer).find((item) => item.name === 'word/document.xml');
    expect(entry).toBeDefined();
    return entry!.data.toString('utf8');
  }

  function visibleTexts(xml: string): string[] {
    return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]);
  }

  it('GET /api/templates 返回 gov 政务公文与 tech 技术方案', async () => {
    const res = await api<TemplatesResponse>(baseUrl, '/api/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates.map((template) => template.id)).toEqual(['gov', 'tech']);
    const gov = res.body.templates.find((template) => template.id === 'gov')!;
    const tech = res.body.templates.find((template) => template.id === 'tech')!;
    expect(gov.name).toBe('政务公文');
    expect(tech.name).toBe('技术方案');
    expect(gov.description.length).toBeGreaterThan(0);
    expect(tech.description.length).toBeGreaterThan(0);
  });

  it('template=gov：小标宋/黑体/仿宋、28pt 固定行距、A4 公文页边距', async () => {
    const result = await download(`/api/documents/${ctx.documentId}/export.docx?template=gov`);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe(DOCX_MIME);
    expect(looksLikeZip(result.buffer)).toBe(true);

    const entries = readZipEntries(result.buffer).map((entry) => entry.name);
    expect(entries).toContain('[Content_Types].xml');
    expect(entries).toContain('word/document.xml');
    expect(entries).toContain('word/styles.xml');

    const xml = documentXml(result.buffer);
    // 版式：标题小标宋、章节黑体、正文仿宋。
    expect(xml).toContain('方正小标宋简体');
    expect(xml).toContain('黑体');
    expect(xml).toContain('仿宋_GB2312');
    // 28pt 固定行距（560 twips / exact）。
    expect(xml).toContain('w:line="560"');
    expect(xml).toContain('w:lineRule="exact"');
    // A4 公文页边距（上 37mm/下 35mm/左 28mm/右 26mm）与 A4 纸张。
    expect(xml).toContain('<w:pgSz');
    expect(xml).toContain('w:w="11906"');
    expect(xml).toContain('w:h="16838"');
    expect(xml).toContain('w:top="2098"');
    expect(xml).toContain('w:bottom="1984"');
    expect(xml).toContain('w:left="1587"');
    expect(xml).toContain('w:right="1474"');
    // 正文内容不变：种子正文与章标题仍可见。
    expect(xml).toContain('第一章 项目背景与目标');
    expect(xml).toContain('政务服务热线');
  });

  it('默认 tech：微软雅黑、1.5 倍行距；与显式 template=tech 一致且不改正文', async () => {
    const tech = await download(`/api/documents/${ctx.documentId}/export.docx?template=tech`);
    const defaultExport = await download(`/api/documents/${ctx.documentId}/export.docx`);
    expect(tech.status).toBe(200);
    expect(defaultExport.status).toBe(200);
    expect(defaultExport.contentType).toBe(DOCX_MIME);

    const techXml = documentXml(tech.buffer);
    const defaultXml = documentXml(defaultExport.buffer);
    expect(techXml).toContain('微软雅黑');
    expect(techXml).toContain('Microsoft YaHei');
    // 1.5 倍行距（360 twips / auto）。
    expect(techXml).toContain('w:line="360"');
    expect(techXml).toContain('w:lineRule="auto"');
    expect(techXml).not.toContain('方正小标宋简体');
    expect(techXml).toContain('w:top="1440"');

    // 默认模板就是 tech（版式一致）。
    expect(defaultXml).toBe(techXml);
  });

  it('模板只改版式不改正文：gov 与 tech 可见文本完全一致', async () => {
    const gov = await download(`/api/documents/${ctx.documentId}/export.docx?template=gov`);
    const tech = await download(`/api/documents/${ctx.documentId}/export.docx?template=tech`);
    const govTexts = visibleTexts(documentXml(gov.buffer));
    const techTexts = visibleTexts(documentXml(tech.buffer));
    expect(govTexts.length).toBeGreaterThan(10);
    expect(govTexts).toEqual(techTexts);
    expect(govTexts.join('')).toContain('第三章 功能拆解与实施路径');
    expect(govTexts.join('')).toContain('审核与兜底机制');
  });

  it('template 非法值返回 400；template 可与 versionId 组合', async () => {
    const invalid = await download(`/api/documents/${ctx.documentId}/export.docx?template=pdf`);
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.buffer.toString('utf8')).error.code).toBe('validation_error');

    const versions = await api<{ versions: Array<{ id: string; name: string }> }>(
      baseUrl,
      `/api/documents/${ctx.documentId}/versions`,
    );
    const v10 = versions.body.versions.find((version) => version.name === 'V1.0')!;
    const versioned = await download(
      `/api/documents/${ctx.documentId}/export.docx?template=gov&versionId=${v10.id}`,
    );
    expect(versioned.status).toBe(200);
    const xml = documentXml(versioned.buffer);
    expect(xml).toContain('方正小标宋简体');
    expect(xml).toContain('第一章 项目背景与目标');
  });
});
