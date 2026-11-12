/**
 * P1-1 引用资料定位 API 测试：小节自动切分/sectionCount、@ locator 检索、小节列表与来源打开、
 * 旧数据懒补齐、项目归属隔离。全部使用内存 SQLite，不访问网络。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createReference } from '../src/services/referencesService.js';
import type { Reference, ReferenceLocatorResult, ReferenceSection } from '../src/types.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

const contexts: TestContext[] = [];
const servers: TestServer[] = [];

async function setup(): Promise<{ ctx: TestContext; baseUrl: string }> {
  const ctx = makeTestContext();
  const server = await startTestServer(ctx.app);
  contexts.push(ctx);
  servers.push(server);
  return { ctx, baseUrl: server.baseUrl };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

interface ReferencesResponse {
  references: Reference[];
}
interface SectionsResponse {
  reference: Reference;
  sections: ReferenceSection[];
}
interface SectionResponse {
  reference: Reference;
  section: ReferenceSection;
}
interface LocatorsResponse {
  results: ReferenceLocatorResult[];
}
interface ErrorResponse {
  error: { code: string; message: string };
}

function fileForm(content: string, filename: string, type: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([new TextEncoder().encode(content)], { type }), filename);
  return form;
}

function sectionCountInDb(ctx: TestContext, referenceId: string): number {
  const row = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM reference_sections WHERE reference_id = ?')
    .get(referenceId) as unknown as { n: number };
  return Number(row.n);
}

async function listReferences(baseUrl: string, projectId: string): Promise<Reference[]> {
  const response = await api<ReferencesResponse>(baseUrl, `/api/projects/${projectId}/references`);
  expect(response.status).toBe(200);
  return response.body.references;
}

describe('P1 引用列表：sectionCount', () => {
  it('种子引用返回 sectionCount，且与 reference_sections 实际条数一致', async () => {
    const { ctx, baseUrl } = await setup();
    const references = await listReferences(baseUrl, ctx.projectId);
    expect(references.length).toBeGreaterThanOrEqual(2);
    for (const reference of references) {
      expect(reference.sectionCount).toBeGreaterThan(0);
      expect(reference.sectionCount).toBe(sectionCountInDb(ctx, reference.id));
    }
  });

  it('上传 .md 后自动切分小节并返回 sectionCount', async () => {
    const { ctx, baseUrl } = await setup();
    const markdown = [
      '# 技术说明（上传测试）',
      '',
      '## 第 1 节 检索链路',
      '关键词召回与向量召回组合，重排优先保证原文。',
      '',
      '## 第 2 节 数据分级',
      'public/internal 可外发，secret 一律阻断。',
      '',
      '补充：日志不得记录密钥。',
    ].join('\n');
    const response = await api<{ reference: Reference }>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references`,
      { method: 'POST', body: fileForm(markdown, 'uploaded-notes.md', 'text/markdown') },
    );
    expect(response.status).toBe(201);
    expect(response.body.reference.sectionCount).toBe(3);

    const sectionsResponse = await api<SectionsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${response.body.reference.id}/sections`,
    );
    expect(sectionsResponse.status).toBe(200);
    expect(sectionsResponse.body.sections.map((section) => section.locator)).toEqual([
      '第 1 节 检索链路 / 第 1 段',
      '第 2 节 数据分级 / 第 1 段',
      '第 2 节 数据分级 / 第 2 段',
    ]);
  });
});

describe('P1 @ locator 检索', () => {
  it('按关键词命中引用小节，返回 referenceId/referenceTitle/sectionId/locator/excerpt', async () => {
    const { ctx, baseUrl } = await setup();
    const response = await api<LocatorsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/locators?q=${encodeURIComponent('试点')}&limit=20`,
    );
    expect(response.status).toBe(200);
    expect(response.body.results.length).toBeGreaterThan(0);
    const references = await listReferences(baseUrl, ctx.projectId);
    const referenceIds = new Set(references.map((reference) => reference.id));
    for (const hit of response.body.results) {
      expect(referenceIds.has(hit.referenceId)).toBe(true);
      expect(hit.referenceTitle.length).toBeGreaterThan(0);
      expect(hit.sectionId).toMatch(/^rsec_/);
      expect(hit.locator).toContain('第');
      expect(hit.locator).toContain('段');
      expect(hit.excerpt.length).toBeGreaterThan(0);
      expect(hit.excerpt.length).toBeLessThanOrEqual(300);
    }
    expect(response.body.results.some((hit) => hit.locator.includes('试点'))).toBe(true);
  });

  it('空查询返回默认顺序结果，limit 生效且越界/非法值 400 validation_error', async () => {
    const { ctx, baseUrl } = await setup();
    const limited = await api<LocatorsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/locators?q=&limit=2`,
    );
    expect(limited.status).toBe(200);
    expect(limited.body.results).toHaveLength(2);

    for (const badLimit of ['0', '51', 'abc', '1.5']) {
      const bad = await api<ErrorResponse>(
        baseUrl,
        `/api/projects/${ctx.projectId}/references/locators?limit=${encodeURIComponent(badLimit)}`,
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('validation_error');
    }
  });

  it('不存在的项目 → 404 not_found', async () => {
    const { baseUrl } = await setup();
    const response = await api<ErrorResponse>(
      baseUrl,
      '/api/projects/prj_not_exists/references/locators?q=试点',
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});

describe('P1 小节列表与来源打开', () => {
  it('GET sections 按 paragraphIndex 升序，locator 含小节与段号', async () => {
    const { baseUrl, ctx } = await setup();
    const references = await listReferences(baseUrl, ctx.projectId);
    const reference = references[0];
    const response = await api<SectionsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${reference.id}/sections`,
    );
    expect(response.status).toBe(200);
    expect(response.body.reference.id).toBe(reference.id);
    expect(response.body.reference.sectionCount).toBe(response.body.sections.length);
    expect(response.body.sections.length).toBe(reference.sectionCount);
    const indexes = response.body.sections.map((section) => section.paragraphIndex);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    for (const section of response.body.sections) {
      expect(section.referenceId).toBe(reference.id);
      expect(section.locator).toMatch(/ \/ 第 \d+ 段$/);
      expect(section.sectionTitle.length).toBeGreaterThan(0);
      expect(section.content.length).toBeGreaterThan(0);
      expect(section.excerpt.length).toBeLessThanOrEqual(300);
    }
  });

  it('GET 单个小节返回完整内容；不存在的小节 → 404 not_found', async () => {
    const { baseUrl, ctx } = await setup();
    const references = await listReferences(baseUrl, ctx.projectId);
    const reference = references[0];
    const sectionsResponse = await api<SectionsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${reference.id}/sections`,
    );
    const target = sectionsResponse.body.sections[1] ?? sectionsResponse.body.sections[0];
    const response = await api<SectionResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${reference.id}/sections/${target.id}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.reference.id).toBe(reference.id);
    expect(response.body.section).toEqual(target);

    const missing = await api<ErrorResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${reference.id}/sections/rsec_not_exists`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('引用不属于该项目 → 404 not_found（跨项目不泄露存在性）', async () => {
    const { ctx, baseUrl } = await setup();
    const projectResponse = await jsonApi<{ project: { id: string } }>(
      baseUrl,
      'POST',
      '/api/projects',
      { name: '另一个项目' },
    );
    expect(projectResponse.status).toBe(201);
    const otherProjectId = projectResponse.body.project.id;
    const otherReference = await createReference(ctx.db, otherProjectId, {
      filename: 'other-project.md',
      buffer: Buffer.from('## 第 1 节 其它项目\n其它项目专用内容。', 'utf8'),
    });

    const wrongProject = await api<ErrorResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${otherReference.id}/sections`,
    );
    expect(wrongProject.status).toBe(404);
    expect(wrongProject.body.error.code).toBe('not_found');

    // 检索只返回本项目小节。
    const locators = await api<LocatorsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/locators?q=${encodeURIComponent('其它项目专用')}`,
    );
    expect(locators.status).toBe(200);
    expect(locators.body.results).toHaveLength(0);
  });
});

describe('P1 旧数据兼容（懒补齐）', () => {
  it('旧引用缺少小节时，读取 sections 自动补齐', async () => {
    const { ctx, baseUrl } = await setup();
    const references = await listReferences(baseUrl, ctx.projectId);
    const reference = references[0];
    const expected = sectionCountInDb(ctx, reference.id);
    expect(expected).toBeGreaterThan(0);

    // 模拟 P0 历史数据：引用存在但没有 reference_sections。
    ctx.db.prepare('DELETE FROM reference_sections WHERE reference_id = ?').run(reference.id);
    expect(sectionCountInDb(ctx, reference.id)).toBe(0);

    const response = await api<SectionsResponse>(
      baseUrl,
      `/api/projects/${ctx.projectId}/references/${reference.id}/sections`,
    );
    expect(response.status).toBe(200);
    expect(response.body.sections).toHaveLength(expected);
    expect(sectionCountInDb(ctx, reference.id)).toBe(expected);
    expect(response.body.reference.sectionCount).toBe(expected);
  });
});
