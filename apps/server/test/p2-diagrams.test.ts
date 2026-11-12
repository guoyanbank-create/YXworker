/**
 * P2 图表 API 测试（API_CONTRACT P2-5）：CRUD、默认/命名版本绑定、参数校验与引用清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Diagram, Document, FeatureSpec, Version } from '../src/types.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

interface DiagramResponse {
  diagram: Diagram;
}
interface DiagramsResponse {
  diagrams: Diagram[];
}
interface VersionsResponse {
  versions: Version[];
}
interface DocumentResponse {
  document: Document;
}
interface FeatureResponse {
  feature: FeatureSpec;
}
interface ProjectResponse {
  project: { id: string; documentId: string };
}
interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}

describe('P2 图表 API（Mermaid 源码 + 版本绑定）', () => {
  let ctx: TestContext;
  let server: TestServer;
  let baseUrl: string;
  let versionV10Id = '';
  let defaultBoundId = '';
  let versionBoundId = '';

  beforeAll(async () => {
    ctx = makeTestContext();
    server = await startTestServer(ctx.app);
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    ctx.db.close();
  });

  async function fetchDocument(): Promise<Document> {
    const res = await api<DocumentResponse>(baseUrl, `/api/documents/${ctx.documentId}`);
    expect(res.status).toBe(200);
    return res.body.document;
  }

  it('种子项目预置 2 张 Mermaid 图表，默认绑定 V1.0（revision + name）', async () => {
    const versions = await api<VersionsResponse>(
      baseUrl,
      `/api/documents/${ctx.documentId}/versions`,
    );
    expect(versions.status).toBe(200);
    const v10 = versions.body.versions.find((version) => version.name === 'V1.0');
    expect(v10).toBeDefined();
    versionV10Id = v10!.id;

    const res = await api<DiagramsResponse>(baseUrl, `/api/projects/${ctx.projectId}/diagrams`);
    expect(res.status).toBe(200);
    expect(res.body.diagrams.length).toBe(2);
    for (const diagram of res.body.diagrams) {
      expect(diagram.projectId).toBe(ctx.projectId);
      expect(diagram.documentId).toBe(ctx.documentId);
      expect(diagram.documentRevision).toBe(1);
      expect(diagram.versionName).toBe('V1.0');
      expect(diagram.source.length).toBeGreaterThan(0);
      expect(['flowchart', 'architecture']).toContain(diagram.kind);
    }
  });

  it('POST 默认绑定当前 revision；传 versionId 绑定命名版本', async () => {
    const created = await jsonApi<DiagramResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/diagrams`,
      {
        title: '新增时序图',
        kind: 'sequence',
        source: 'sequenceDiagram\n  A->>B: 你好',
        description: '测试图表',
        chapterRef: '第三章 功能拆解与实施路径',
      },
    );
    expect(created.status).toBe(201);
    defaultBoundId = created.body.diagram.id;
    expect(created.body.diagram.projectId).toBe(ctx.projectId);
    expect(created.body.diagram.documentId).toBe(ctx.documentId);
    expect(created.body.diagram.documentRevision).toBe(1);
    expect(created.body.diagram.versionName).toBeNull();
    expect(created.body.diagram.chapterRef).toBe('第三章 功能拆解与实施路径');

    const bound = await jsonApi<DiagramResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/diagrams`,
      { title: '绑定命名版本', kind: 'state', source: 'stateDiagram-v2\n  [*] --> A', versionId: versionV10Id },
    );
    expect(bound.status).toBe(201);
    versionBoundId = bound.body.diagram.id;
    expect(bound.body.diagram.documentRevision).toBe(1);
    expect(bound.body.diagram.versionName).toBe('V1.0');
  });

  it('参数校验：title/source/kind 必填与枚举，versionId 不存在返回 404', async () => {
    const noTitle = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/diagrams`,
      { source: 'flowchart TD\n A-->B' },
    );
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error.code).toBe('validation_error');

    const emptySource = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/diagrams`,
      { title: '空源码', source: '' },
    );
    expect(emptySource.status).toBe(400);
    expect(emptySource.body.error.code).toBe('validation_error');

    const badKind = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/diagrams`,
      { title: '非法类型', source: 'flowchart TD\n A-->B', kind: 'pie' },
    );
    expect(badKind.status).toBe(400);
    expect(badKind.body.error.code).toBe('validation_error');

    const badVersion = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/diagrams`,
      { title: '版本不存在', source: 'flowchart TD\n A-->B', versionId: 'ver_not_exist' },
    );
    expect(badVersion.status).toBe(404);
    expect(badVersion.body.error.code).toBe('not_found');
  });

  it('PUT 更新内容默认重新绑定当前 revision，也可显式绑定命名版本', async () => {
    // 通过保存正文把文档 revision 推进到 2，用于验证重新绑定。
    const before = await fetchDocument();
    const saved = await jsonApi<DocumentResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: before.contentJson, baseRevision: before.revision },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.document.revision).toBe(before.revision + 1);

    const updated = await jsonApi<DiagramResponse>(
      baseUrl,
      'PUT',
      `/api/diagrams/${defaultBoundId}`,
      { title: '改名后的时序图', description: '更新描述' },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.diagram.title).toBe('改名后的时序图');
    expect(updated.body.diagram.description).toBe('更新描述');
    expect(updated.body.diagram.documentRevision).toBe(saved.body.document.revision);
    expect(updated.body.diagram.versionName).toBeNull();

    const rebound = await jsonApi<DiagramResponse>(
      baseUrl,
      'PUT',
      `/api/diagrams/${defaultBoundId}`,
      { versionId: versionV10Id },
    );
    expect(rebound.status).toBe(200);
    expect(rebound.body.diagram.documentRevision).toBe(1);
    expect(rebound.body.diagram.versionName).toBe('V1.0');

    const badKind = await jsonApi<ErrorResponse>(
      baseUrl,
      'PUT',
      `/api/diagrams/${defaultBoundId}`,
      { kind: 'pie' },
    );
    expect(badKind.status).toBe(400);
  });

  it('bind 显式绑定命名版本；不存在/跨文档版本返回 404', async () => {
    const bound = await jsonApi<DiagramResponse>(
      baseUrl,
      'POST',
      `/api/diagrams/${defaultBoundId}/bind`,
      { versionId: versionV10Id },
    );
    expect(bound.status).toBe(200);
    expect(bound.body.diagram.versionName).toBe('V1.0');
    expect(bound.body.diagram.documentRevision).toBe(1);

    const missingVersion = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/diagrams/${defaultBoundId}/bind`,
      { versionId: 'ver_not_exist' },
    );
    expect(missingVersion.status).toBe(404);
    expect(missingVersion.body.error.code).toBe('not_found');

    // 另一个项目的命名版本：不允许绑定（404）。
    const other = await jsonApi<ProjectResponse>(baseUrl, 'POST', '/api/projects', {
      name: '另一个项目',
    });
    const otherVersions = await api<VersionsResponse>(
      baseUrl,
      `/api/documents/${other.body.project.documentId}/versions`,
    );
    const crossBind = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/diagrams/${defaultBoundId}/bind`,
      { versionId: otherVersions.body.versions[0].id },
    );
    expect(crossBind.status).toBe(404);
    expect(crossBind.body.error.code).toBe('not_found');
  });

  it('GET/DELETE 图表；删除时清理功能清单的 diagramId 引用', async () => {
    const one = await api<DiagramResponse>(baseUrl, `/api/diagrams/${defaultBoundId}`);
    expect(one.status).toBe(200);
    expect(one.body.diagram.id).toBe(defaultBoundId);

    const feature = await jsonApi<FeatureResponse>(
      baseUrl,
      'POST',
      `/api/projects/${ctx.projectId}/features`,
      { title: '关联图表的条目', diagramId: defaultBoundId },
    );
    expect(feature.status).toBe(201);
    expect(feature.body.feature.diagramId).toBe(defaultBoundId);

    const deleted = await api(baseUrl, `/api/diagrams/${defaultBoundId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    const gone = await api<ErrorResponse>(baseUrl, `/api/diagrams/${defaultBoundId}`);
    expect(gone.status).toBe(404);

    // 功能清单不再引用被删除的图表。
    const afterDelete = await api<FeatureResponse>(
      baseUrl,
      `/api/features/${feature.body.feature.id}`,
    );
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.feature.diagramId).toBeNull();

    const list = await api<DiagramsResponse>(baseUrl, `/api/projects/${ctx.projectId}/diagrams`);
    expect(list.body.diagrams.some((diagram) => diagram.id === defaultBoundId)).toBe(false);
    expect(list.body.diagrams.some((diagram) => diagram.id === versionBoundId)).toBe(true);
  });

  it('项目/图表不存在时返回 404', async () => {
    const project = await api<ErrorResponse>(baseUrl, '/api/projects/prj_not_exist/diagrams');
    expect(project.status).toBe(404);
    expect(project.body.error.code).toBe('not_found');

    const create = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/projects/prj_not_exist/diagrams',
      { title: 'x', source: 'flowchart TD\n A-->B' },
    );
    expect(create.status).toBe(404);

    const missing = await api<ErrorResponse>(baseUrl, '/api/diagrams/dia_not_exist');
    expect(missing.status).toBe(404);
  });
});
