/**
 * P2 功能清单 API 测试（API_CONTRACT P2-6）：CRUD、默认值、status/priority 枚举校验。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Diagram, FeatureSpec } from '../src/types.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

interface FeatureResponse {
  feature: FeatureSpec;
}
interface FeaturesResponse {
  features: FeatureSpec[];
}
interface DiagramResponse {
  diagram: Diagram;
}
interface ProjectResponse {
  project: { id: string; documentId: string };
}
interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}

describe('P2 功能清单 API（FeatureSpec）', () => {
  let ctx: TestContext;
  let server: TestServer;
  let baseUrl: string;
  let seededDiagramId = '';

  beforeAll(async () => {
    ctx = makeTestContext();
    server = await startTestServer(ctx.app);
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    ctx.db.close();
  });

  it('种子项目预置 4 条功能清单（status/priority/chapterRef 完整）', async () => {
    const res = await api<FeaturesResponse>(baseUrl, `/api/projects/${ctx.projectId}/features`);
    expect(res.status).toBe(200);
    expect(res.body.features.length).toBe(4);
    expect(res.body.features.map((feature) => feature.priority)).toEqual([
      'P0',
      'P0',
      'P0',
      'P1',
    ]);
    for (const feature of res.body.features) {
      expect(feature.projectId).toBe(ctx.projectId);
      expect(['planned', 'in_progress', 'done', 'dropped']).toContain(feature.status);
      expect(feature.chapterRef).toBeTruthy();
      expect(feature.diagramId).toBeNull();
    }
    seededDiagramId = (await api<{ diagrams: Diagram[] }>(
      baseUrl,
      `/api/projects/${ctx.projectId}/diagrams`,
    )).body.diagrams[0].id;
  });

  it('POST 默认 status=planned/priority=P1；可指定枚举与图表引用', async () => {
    const minimal = await jsonApi<FeatureResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: '仅标题的功能条目' },
    );
    expect(minimal.status).toBe(201);
    expect(minimal.body.feature.status).toBe('planned');
    expect(minimal.body.feature.priority).toBe('P1');
    expect(minimal.body.feature.description).toBe('');
    expect(minimal.body.feature.chapterRef).toBeNull();
    expect(minimal.body.feature.diagramId).toBeNull();

    const full = await jsonApi<FeatureResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      {
        title: '完整功能条目',
        description: '描述',
        status: 'done',
        priority: 'P2',
        chapterRef: '第三章 功能拆解与实施路径',
        diagramId: seededDiagramId,
      },
    );
    expect(full.status).toBe(201);
    expect(full.body.feature.status).toBe('done');
    expect(full.body.feature.priority).toBe('P2');
    expect(full.body.feature.chapterRef).toBe('第三章 功能拆解与实施路径');
    expect(full.body.feature.diagramId).toBe(seededDiagramId);

    const single = await api<FeatureResponse>(baseUrl, `/api/features/${full.body.feature.id}`);
    expect(single.status).toBe(200);
    expect(single.body.feature.id).toBe(full.body.feature.id);
  });

  it('status/priority 枚举与 diagramId 归属校验', async () => {
    const badStatus = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: 'x', status: 'blocked' },
    );
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.code).toBe('validation_error');

    const badPriority = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: 'x', priority: 'P9' },
    );
    expect(badPriority.status).toBe(400);
    expect(badPriority.body.error.code).toBe('validation_error');

    const emptyTitle = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: '   ' },
    );
    expect(emptyTitle.status).toBe(400);

    const missingDiagram = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: 'x', diagramId: 'dia_not_exist' },
    );
    expect(missingDiagram.status).toBe(404);

    // 其它项目的图表不能被引用（避免跨项目脏关联）。
    const other = await jsonApi<ProjectResponse>(baseUrl, 'POST', '/api/projects', {
      name: '另一个功能项目',
    });
    const otherDiagram = await jsonApi<DiagramResponse>(
      baseUrl,
      'POST',
      `/api/projects/${other.body.project.id}/diagrams`,
      { title: '别的项目的图', source: 'flowchart TD\n A-->B' },
    );
    const crossDiagram = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: 'x', diagramId: otherDiagram.body.diagram.id },
    );
    expect(crossDiagram.status).toBe(404);
    expect(crossDiagram.body.error.code).toBe('not_found');
  });

  it('PATCH 局部更新 status/priority/chapterRef/diagramId（含清空引用）', async () => {
    const created = await jsonApi<FeatureResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: '待更新条目', diagramId: seededDiagramId },
    );
    expect(created.status).toBe(201);

    const patched = await jsonApi<FeatureResponse>(
      baseUrl,
      'PATCH',
      `/api/features/${created.body.feature.id}`,
      { status: 'in_progress', priority: 'P0', chapterRef: '第四章 预期成效与保障措施' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.feature.status).toBe('in_progress');
    expect(patched.body.feature.priority).toBe('P0');
    expect(patched.body.feature.chapterRef).toBe('第四章 预期成效与保障措施');
    // 未提供的字段保持不变。
    expect(patched.body.feature.title).toBe('待更新条目');
    expect(patched.body.feature.diagramId).toBe(seededDiagramId);

    const cleared = await jsonApi<FeatureResponse>(
      baseUrl,
      'PATCH',
      `/api/features/${created.body.feature.id}`,
      { diagramId: null, chapterRef: null },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.feature.diagramId).toBeNull();
    expect(cleared.body.feature.chapterRef).toBeNull();

    const badPatch = await jsonApi<ErrorResponse>(
      baseUrl,
      'PATCH',
      `/api/features/${created.body.feature.id}`,
      { status: 'blocked' },
    );
    expect(badPatch.status).toBe(400);

    const missing = await jsonApi<ErrorResponse>(
      baseUrl,
      'PATCH',
      '/api/features/feat_not_exist',
      { status: 'done' },
    );
    expect(missing.status).toBe(404);
  });

  it('DELETE 功能条目后返回 404', async () => {
    const created = await jsonApi<FeatureResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: '待删除条目' },
    );
    expect(created.status).toBe(201);

    const deleted = await api(baseUrl, `/api/features/${created.body.feature.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    const gone = await api<ErrorResponse>(baseUrl, `/api/features/${created.body.feature.id}`);
    expect(gone.status).toBe(404);

    const list = await api<FeaturesResponse>(baseUrl, `/api/projects/${ctx.projectId}/features`);
    expect(list.body.features.some((item) => item.id === created.body.feature.id)).toBe(false);
  });

  it('项目不存在时返回 404', async () => {
    const list = await api<ErrorResponse>(baseUrl, '/api/projects/prj_not_exist/features');
    expect(list.status).toBe(404);
    const create = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/projects/prj_not_exist/features',
      { title: 'x' },
    );
    expect(create.status).toBe(404);
  });
});
