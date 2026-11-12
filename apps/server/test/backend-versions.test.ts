/**
 * 版本 API 测试：版本列表 / 创建命名版本 / 回退生成新 revision（历史保留）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyParagraphText } from '../src/domain/paragraphs.js';
import type { Document, Version } from '../src/types.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

interface DocumentResponse {
  document: Document;
}
interface VersionsResponse {
  versions: Version[];
}
interface VersionResponse {
  version: Version;
}
interface ErrorResponse {
  error: { code: string; message: string };
}

describe('版本 API', () => {
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

  async function fetchDocument(id = ctx.documentId): Promise<Document> {
    const res = await api<DocumentResponse>(baseUrl, `/api/documents/${id}`);
    expect(res.status).toBe(200);
    return res.body.document;
  }

  async function fetchVersions(id = ctx.documentId): Promise<Version[]> {
    const res = await api<VersionsResponse>(baseUrl, `/api/documents/${id}/versions`);
    expect(res.status).toBe(200);
    return res.body.versions;
  }

  it('GET /api/documents/:id/versions 返回升序版本（种子 V1.0）', async () => {
    const versions = await fetchVersions();
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0]).toMatchObject({
      documentId: ctx.documentId,
      name: 'V1.0',
      revision: 1,
      createdBy: 'system',
    });
    expect((versions[0].contentJson as { type: string }).type).toBe('doc');
  });

  it('POST 创建 V1.1 快照并保持与历史版本相互独立', async () => {
    const before = await fetchDocument();
    const target = before.paragraphs.find((block) => block.type === 'paragraph')!;
    const marker = 'V1.1 快照专用文本：结构已在评审中确认。';
    const patched = applyParagraphText(before.contentJson, target.id, marker);
    const saved = await jsonApi<{ document: Document }>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: patched.contentJson, baseRevision: before.revision },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.document.revision).toBe(before.revision + 1);

    const created = await jsonApi<VersionResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/versions`,
      { name: 'V1.1' },
    );
    expect(created.status).toBe(201);
    expect(created.body.version).toMatchObject({
      documentId: ctx.documentId,
      name: 'V1.1',
      revision: saved.body.document.revision,
      createdBy: 'user',
    });
    expect(JSON.stringify(created.body.version.contentJson)).toContain(marker);

    const versions = await fetchVersions();
    expect(versions.map((version) => version.name)).toEqual(['V1.0', 'V1.1']);
    expect(JSON.stringify(versions[0].contentJson)).not.toContain(marker);
  });

  it('版本名称在同一文档内唯一：重复创建返回 409', async () => {
    const duplicate = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/versions`,
      { name: 'V1.1' },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('version_conflict');
  });

  it('版本名称校验：空名称 / 缺失名称返回 400 validation_error', async () => {
    const empty = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/versions`,
      { name: '   ' },
    );
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_error');

    const missing = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/versions`,
      {},
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_error');
  });

  it('不存在的文档/版本返回 404', async () => {
    const listMissing = await api<ErrorResponse>(baseUrl, '/api/documents/doc_not_exist/versions');
    expect(listMissing.status).toBe(404);
    expect(listMissing.body.error.code).toBe('not_found');

    const createMissing = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/documents/doc_not_exist/versions',
      { name: 'V1.0' },
    );
    expect(createMissing.status).toBe(404);

    const restoreMissing = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/versions/ver_not_exist/restore',
      {},
    );
    expect(restoreMissing.status).toBe(404);
    expect(restoreMissing.body.error.code).toBe('not_found');
  });

  it('POST /api/versions/:id/restore 生成新 revision 并保留历史版本', async () => {
    const versions = await fetchVersions();
    const original = versions.find((version) => version.name === 'V1.0')!;
    const before = await fetchDocument();

    const restored = await jsonApi<DocumentResponse>(
      baseUrl,
      'POST',
      `/api/versions/${original.id}/restore`,
      {},
    );
    expect(restored.status).toBe(200);
    expect(restored.body.document.id).toBe(ctx.documentId);
    expect(restored.body.document.revision).toBe(before.revision + 1);
    const restoredJson = JSON.stringify(restored.body.document.contentJson);
    expect(restoredJson).not.toContain('V1.1 快照专用文本');
    expect(restored.body.document.paragraphs[0].text).toBe('第一章 项目背景与目标');

    // 回退后历史版本仍在，且快照内容未被改写。
    const afterVersions = await fetchVersions();
    expect(afterVersions.map((version) => version.name)).toEqual(['V1.0', 'V1.1']);
    expect(JSON.stringify(afterVersions.find((version) => version.name === 'V1.1')?.contentJson)).toContain(
      'V1.1 快照专用文本',
    );

    // 持久化生效。
    const reloaded = await fetchDocument();
    expect(reloaded.revision).toBe(before.revision + 1);
    expect(JSON.stringify(reloaded.contentJson)).not.toContain('V1.1 快照专用文本');
  });
});
