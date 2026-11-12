/**
 * 文档 API 测试：权威正文读取、保存乐观锁 409、缺失 paragraphId 兜底、
 * 以及“人工保存导致旧提案冲突”的联动（依赖 proposalService 契约实现）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContentJson, applyParagraphText, extractParagraphs, hashText } from '../src/domain/paragraphs.js';
import { DEMO_CHAPTERS } from '../src/seed/content.js';
import type { Document, Proposal } from '../src/types.js';
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
interface SaveResponse {
  document: Document;
  conflictedProposals: Proposal[];
}
interface ErrorResponse {
  error: { code: string; message: string; details?: { currentRevision?: number } };
}

describe('文档 API', () => {
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

  it('GET /api/documents/:id 返回 TipTap JSON 与服务端派生段落块', async () => {
    const document = await fetchDocument();
    expect(document.id).toBe(ctx.documentId);
    expect(document.projectId).toBe(ctx.projectId);
    expect(document.revision).toBe(1);
    expect((document.contentJson as { type: string }).type).toBe('doc');

    const expected = extractParagraphs(buildContentJson(DEMO_CHAPTERS));
    expect(document.paragraphs).toHaveLength(expected.length);
    expect(document.paragraphs.map((block) => block.id)).toEqual(expected.map((block) => block.id));
    expect(document.paragraphs[0]).toMatchObject({
      type: 'heading',
      level: 1,
      chapterIndex: 0,
      chapterTitle: '第一章 项目背景与目标',
    });
    for (const block of document.paragraphs) {
      expect(block.hash).toBe(hashText(block.text));
    }
  });

  it('PUT content 保存成功：revision + 1 并重新派生段落块', async () => {
    const before = await fetchDocument();
    const target = before.paragraphs.find((block) => block.type === 'paragraph');
    expect(target).toBeDefined();
    const newText = '保存测试：已由人工修改的正文段落。';
    const patched = applyParagraphText(before.contentJson, target!.id, newText);

    const saved = await jsonApi<SaveResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: patched.contentJson, baseRevision: before.revision, actor: 'tester' },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.document.revision).toBe(before.revision + 1);
    expect(saved.body.conflictedProposals).toEqual([]);
    const savedTarget = saved.body.document.paragraphs[target!.index];
    expect(savedTarget.text).toBe(newText);
    expect(savedTarget.hash).toBe(hashText(newText));

    const reloaded = await fetchDocument();
    expect(reloaded.revision).toBe(before.revision + 1);
    expect(reloaded.paragraphs[target!.index].text).toBe(newText);
  });

  it('PUT content 的 baseRevision 过期 → 409 revision_conflict 且 details.currentRevision', async () => {
    const current = await fetchDocument();
    const patched = applyParagraphText(current.contentJson, current.paragraphs[1].id, '不应写入的内容');
    const conflictRes = await jsonApi<ErrorResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: patched.contentJson, baseRevision: current.revision - 1 },
    );
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('revision_conflict');
    expect(conflictRes.body.error.details?.currentRevision).toBe(current.revision);

    // 冲突时不得写入。
    const after = await fetchDocument();
    expect(after.revision).toBe(current.revision);
    expect(after.paragraphs[1].text).not.toBe('不应写入的内容');
  });

  it('缺失 paragraphId 的段落块由服务端补 auto_<index> 兜底 id', async () => {
    const before = await fetchDocument();
    const contentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { paragraphId: 'keep-1' },
          content: [{ type: 'text', text: '带 id 的段落' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '缺 id 的段落' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '缺 id 的标题' }],
        },
      ],
    };
    const saved = await jsonApi<SaveResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson, baseRevision: before.revision },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.document.paragraphs.map((block) => block.id)).toEqual([
      'keep-1',
      'auto_1',
      'auto_2',
    ]);
    expect(saved.body.document.paragraphs.map((block) => block.text)).toEqual([
      '带 id 的段落',
      '缺 id 的段落',
      '缺 id 的标题',
    ]);
    const stored = saved.body.document.contentJson as {
      content: { attrs?: { paragraphId?: string } }[];
    };
    expect(stored.content[1].attrs?.paragraphId).toBe('auto_1');
    expect(stored.content[2].attrs?.paragraphId).toBe('auto_2');

    const reloaded = await fetchDocument();
    expect(reloaded.paragraphs[1].id).toBe('auto_1');
  });


  it('列表项/引用块内缺失 paragraphId 的段落也按抽取顺序补兜底 id', async () => {
    const before = await fetchDocument();
    const contentJson = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: '列表项一' }] },
                { type: 'paragraph', attrs: { paragraphId: 'kept-li' }, content: [{ type: 'text', text: '列表项二' }] },
              ],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '引用文本' }] },
          ],
        },
        { type: 'paragraph', attrs: { paragraphId: 'kept-p' }, content: [{ type: 'text', text: '普通段落' }] },
      ],
    };
    const saved = await jsonApi<SaveResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson, baseRevision: before.revision },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.document.paragraphs.map((block) => block.id)).toEqual([
      'auto_0',
      'kept-li',
      'auto_2',
      'kept-p',
    ]);
  });

  it('保存保留格式标记、对齐与列表结构（服务端不剥离内容 JSON）', async () => {
    const before = await fetchDocument();
    const contentJson = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 3, paragraphId: 'h-keep', textAlign: 'center' },
          content: [{ type: 'text', text: '保留标题' }],
        },
        {
          type: 'paragraph',
          attrs: { paragraphId: 'p-keep', textAlign: 'right' },
          content: [
            { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
            { type: 'text', text: '斜体', marks: [{ type: 'italic' }] },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', attrs: { paragraphId: 'oi-keep' }, content: [{ type: 'text', text: '有序项' }] },
              ],
            },
          ],
        },
      ],
    };
    const saved = await jsonApi<SaveResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson, baseRevision: before.revision },
    );
    expect(saved.status).toBe(200);
    const stored = saved.body.document.contentJson as {
      content: {
        type: string;
        attrs?: Record<string, unknown>;
        content?: { type: string; text?: string; marks?: unknown[] }[];
      }[];
    };
    expect(stored.content[0].attrs?.textAlign).toBe('center');
    expect(stored.content[0].attrs?.level).toBe(3);
    expect(stored.content[1].attrs?.textAlign).toBe('right');
    expect(stored.content[1].content?.[0].marks).toEqual([{ type: 'bold' }]);
    expect(stored.content[2].type).toBe('orderedList');
    expect(stored.content[2].attrs?.start).toBe(3);
    expect(saved.body.document.paragraphs.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'listItem',
    ]);
    expect(saved.body.document.paragraphs[2].listKind).toBe('orderedList');
  });

  it('contentJson 非法结构返回 400 validation_error，非法 JSON 返回 400 invalid_json', async () => {
    const before = await fetchDocument();

    const missingDocWrap = await jsonApi<ErrorResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: { type: 'paragraph' }, baseRevision: before.revision },
    );
    expect(missingDocWrap.status).toBe(400);
    expect(missingDocWrap.body.error.code).toBe('validation_error');

    const badContent = await jsonApi<ErrorResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: { type: 'doc', content: [{ type: 'paragraph', content: 'not-an-array' }] }, baseRevision: before.revision },
    );
    expect(badContent.status).toBe(400);
    expect(badContent.body.error.code).toBe('validation_error');

    const missingBaseRevision = await jsonApi<ErrorResponse>(
      baseUrl,
      'PUT',
      `/api/documents/${ctx.documentId}/content`,
      { contentJson: { type: 'doc', content: [] } },
    );
    expect(missingBaseRevision.status).toBe(400);
    expect(missingBaseRevision.body.error.code).toBe('validation_error');

    const invalidJson = await api<ErrorResponse>(baseUrl, `/api/documents/${ctx.documentId}/content`, {
      method: 'PUT',
      body: '{not-json',
    });
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body.error.code).toBe('invalid_json');

    // 所有失败请求都不得改变文档。
    const after = await fetchDocument();
    expect(after.revision).toBe(before.revision);
  });

  it('不存在的文档返回 404 not_found', async () => {
    const missing = await api<ErrorResponse>(baseUrl, '/api/documents/doc_not_exist');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    const saveMissing = await jsonApi<ErrorResponse>(
      baseUrl,
      'PUT',
      '/api/documents/doc_not_exist/content',
      { contentJson: { type: 'doc', content: [] }, baseRevision: 1 },
    );
    expect(saveMissing.status).toBe(404);
    expect(saveMissing.body.error.code).toBe('not_found');
  });

  describe('保存导致旧提案冲突（proposalService 契约联动）', () => {
    interface ProposalRow {
      id: string;
      status: string;
      conflict_reason: string | null;
    }

    function insertProposal(target: { id: string; index: number; chapterTitle: string; text: string; hash: string }, revision: number): string {
      const id = `prop_test_${Math.random().toString(36).slice(2, 10)}`;
      const at = new Date().toISOString();
      ctx.db
        .prepare(
          `INSERT INTO proposals (
             id, document_id, run_id, status, paragraph_id, paragraph_index, chapter_title,
             quote, old_text, new_text, reason, citations_json, model, provider, backend, tier,
             base_revision, base_hash, discussion_count, created_at, updated_at,
             decided_at, reviewer, conflict_reason
           ) VALUES (?, ?, NULL, 'proposed', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          id,
          ctx.documentId,
          target.id,
          target.index,
          target.chapterTitle,
          target.text,
          target.text,
          'AI 建议的新文本',
          '测试用提案',
          'mock-model',
          'mock',
          'mock',
          'review',
          revision,
          target.hash,
          at,
          at,
        );
      return id;
    }

    function readProposal(id: string): ProposalRow {
      return ctx.db
        .prepare('SELECT id, status, conflict_reason FROM proposals WHERE id = ?')
        .get(id) as unknown as ProposalRow;
    }

    /** 把文档重置为两段落结构，避免测试间共享内容状态。 */
    async function resetToTwoParagraphs(): Promise<Document> {
      const before = await fetchDocument();
      const contentJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { paragraphId: 'para-a' },
            content: [{ type: 'text', text: '冲突测试段落 A' }],
          },
          {
            type: 'paragraph',
            attrs: { paragraphId: 'para-b' },
            content: [{ type: 'text', text: '冲突测试段落 B' }],
          },
        ],
      };
      const saved = await jsonApi<SaveResponse>(
        baseUrl,
        'PUT',
        `/api/documents/${ctx.documentId}/content`,
        { contentJson, baseRevision: before.revision },
      );
      expect(saved.status).toBe(200);
      return saved.body.document;
    }

    it('人工修改目标段落后，保存请求返回被标记为 conflicted 的提案', async () => {
      const before = await resetToTwoParagraphs();
      const target = before.paragraphs[0];
      const proposalId = insertProposal(target, before.revision);

      const patched = applyParagraphText(
        before.contentJson,
        target.id,
        '人工修改：与旧提案冲突的新文本',
      );
      const saved = await jsonApi<SaveResponse>(
        baseUrl,
        'PUT',
        `/api/documents/${ctx.documentId}/content`,
        { contentJson: patched.contentJson, baseRevision: before.revision },
      );
      expect(saved.status).toBe(200);
      const conflicted = saved.body.conflictedProposals.map((proposal) => proposal.id);
      expect(conflicted).toContain(proposalId);
      const marked = readProposal(proposalId);
      expect(marked.status).toBe('conflicted');
      expect(marked.conflict_reason).toBeTruthy();
    });

    it('只修改其它段落时，未受影响的提案保持 proposed', async () => {
      const before = await resetToTwoParagraphs();
      const target = before.paragraphs[0];
      const untouched = before.paragraphs[1];
      const proposalId = insertProposal(target, before.revision);

      const patched = applyParagraphText(
        before.contentJson,
        untouched.id,
        '人工修改：只改另一个段落',
      );
      const saved = await jsonApi<SaveResponse>(
        baseUrl,
        'PUT',
        `/api/documents/${ctx.documentId}/content`,
        { contentJson: patched.contentJson, baseRevision: before.revision },
      );
      expect(saved.status).toBe(200);
      expect(saved.body.conflictedProposals.map((proposal) => proposal.id)).not.toContain(proposalId);
      expect(readProposal(proposalId).status).toBe('proposed');
    });
  });
});
