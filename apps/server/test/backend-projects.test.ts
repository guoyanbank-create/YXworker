/**
 * 项目 API 测试：列表 / 创建（自动创建空白文档与 V1.0 版本）/ 详情 / PATCH dataLevel。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataLevel, DocumentSummary, Project, Version } from '../src/types.js';
import { DEMO_PROJECT_NAME } from '../src/seed/content.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

interface ProjectsResponse {
  projects: Project[];
}
interface ProjectResponse {
  project: Project;
}
interface ProjectDetailResponse {
  project: Project;
  document: DocumentSummary;
}
interface VersionsResponse {
  versions: Version[];
}
interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}

describe('项目 API', () => {
  let ctx: TestContext;
  let server: TestServer;

  beforeAll(async () => {
    ctx = makeTestContext();
    server = await startTestServer(ctx.app);
  });

  afterAll(async () => {
    await server.close();
    ctx.db.close();
  });

  it('GET /api/projects 返回种子项目', async () => {
    const res = await api<ProjectsResponse>(server.baseUrl, '/api/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    const demo = res.body.projects.find((project) => project.id === ctx.projectId);
    expect(demo).toBeDefined();
    expect(demo?.name).toBe(DEMO_PROJECT_NAME);
    expect(demo?.dataLevel).toBe('internal');
    expect(demo?.documentId).toBe(ctx.documentId);
    expect(demo?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('POST /api/projects 创建项目并自动创建空白文档与 V1.0 版本', async () => {
    const created = await jsonApi<ProjectResponse>(server.baseUrl, 'POST', '/api/projects', {
      name: ' 数据分级验证项目 ',
      description: '演示数据分级对模型调用的影响',
      dataLevel: 'secret',
    });
    expect(created.status).toBe(201);
    const project = created.body.project;
    expect(project.name).toBe('数据分级验证项目');
    expect(project.description).toBe('演示数据分级对模型调用的影响');
    expect(project.dataLevel).toBe('secret');
    expect(project.id).toMatch(/^prj_/);
    expect(project.documentId).toMatch(/^doc_/);

    const detail = await api<ProjectDetailResponse>(
      server.baseUrl,
      `/api/projects/${project.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.project.id).toBe(project.id);
    expect(detail.body.document.id).toBe(project.documentId);
    expect(detail.body.document.projectId).toBe(project.id);
    expect(detail.body.document.title).toBe('数据分级验证项目 方案（V1.0）');
    expect(detail.body.document.revision).toBe(1);
    expect(detail.body.document.paragraphCount).toBe(1);

    const versions = await api<VersionsResponse>(
      server.baseUrl,
      `/api/documents/${project.documentId}/versions`,
    );
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((version) => version.name)).toEqual(['V1.0']);
    expect(versions.body.versions[0].revision).toBe(1);

    const document = await api<{ document: { contentJson: { type: string } } }>(
      server.baseUrl,
      `/api/documents/${project.documentId}`,
    );
    expect(document.body.document.contentJson.type).toBe('doc');
  });

  it('POST /api/projects 未传 dataLevel 时默认 internal', async () => {
    const created = await jsonApi<ProjectResponse>(server.baseUrl, 'POST', '/api/projects', {
      name: '默认分级项目',
    });
    expect(created.status).toBe(201);
    expect(created.body.project.dataLevel).toBe('internal');
    expect(created.body.project.description).toBe('');
  });

  it('PATCH /api/projects/:id 更新 dataLevel（数据分级演示）', async () => {
    const created = await jsonApi<ProjectResponse>(server.baseUrl, 'POST', '/api/projects', {
      name: '分级切换项目',
    });
    const projectId = created.body.project.id;

    const patched = await jsonApi<ProjectResponse>(
      server.baseUrl,
      'PATCH',
      `/api/projects/${projectId}`,
      { dataLevel: 'secret' as DataLevel, name: '分级切换项目（改名）' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.project.dataLevel).toBe('secret');
    expect(patched.body.project.name).toBe('分级切换项目（改名）');

    const detail = await api<ProjectDetailResponse>(
      server.baseUrl,
      `/api/projects/${projectId}`,
    );
    expect(detail.body.project.dataLevel).toBe('secret');
    expect(detail.body.project.name).toBe('分级切换项目（改名）');
  });

  it('PATCH /api/projects/:id 支持改回 public 并保留未传字段', async () => {
    const created = await jsonApi<ProjectResponse>(server.baseUrl, 'POST', '/api/projects', {
      name: '公开项目',
      description: '保留描述',
      dataLevel: 'public',
    });
    const projectId = created.body.project.id;
    const patched = await jsonApi<ProjectResponse>(
      server.baseUrl,
      'PATCH',
      `/api/projects/${projectId}`,
      { dataLevel: 'internal' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.project.dataLevel).toBe('internal');
    expect(patched.body.project.name).toBe('公开项目');
    expect(patched.body.project.description).toBe('保留描述');
  });

  it('参数校验：非法 dataLevel / 空名称返回 400 validation_error', async () => {
    const invalidLevel = await jsonApi<ErrorResponse>(
      server.baseUrl,
      'POST',
      '/api/projects',
      { name: '非法分级', dataLevel: 'top-secret' },
    );
    expect(invalidLevel.status).toBe(400);
    expect(invalidLevel.body.error.code).toBe('validation_error');

    const emptyName = await jsonApi<ErrorResponse>(server.baseUrl, 'POST', '/api/projects', {
      name: '   ',
    });
    expect(emptyName.status).toBe(400);
    expect(emptyName.body.error.code).toBe('validation_error');

    const patched = await jsonApi<ErrorResponse>(
      server.baseUrl,
      'PATCH',
      `/api/projects/${ctx.projectId}`,
      { dataLevel: 'unknown' },
    );
    expect(patched.status).toBe(400);
    expect(patched.body.error.code).toBe('validation_error');
  });

  it('不存在项目返回 404 not_found', async () => {
    const res = await api<ErrorResponse>(server.baseUrl, '/api/projects/prj_not_exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');

    const patched = await jsonApi<ErrorResponse>(
      server.baseUrl,
      'PATCH',
      '/api/projects/prj_not_exist',
      { name: 'x' },
    );
    expect(patched.status).toBe(404);
    expect(patched.body.error.code).toBe('not_found');
  });
});
