/**
 * P2 ImpactPlan / 批量采纳 API 测试（API_CONTRACT P2-7 / P2-8）：
 * 影响章节/图表/功能计算、计划落库与读取、执行批量采纳，以及混合状态的批量采纳。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDocument } from '../src/services/documentsService.js';
import { createProposalsFromDrafts } from '../src/services/proposalService.js';
import type {
  BatchAcceptResult,
  Document,
  ImpactPlan,
  Proposal,
} from '../src/types.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

interface PlanResponse {
  plan: ImpactPlan;
}
interface ExecuteResponse {
  plan: ImpactPlan;
  batch: BatchAcceptResult;
}
interface ProposalResponse {
  proposal: Proposal;
}
interface AcceptResponse {
  proposal: Proposal;
  document: Document;
}
interface ProjectResponse {
  project: { id: string; documentId: string };
}
interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}

/** 种子文档的段落块序号：12=p_013（第三章）、14=p_015（第三章）、22=p_023（第四章）。 */
const CH3_BLOCK = 12;
const CH3_OTHER_BLOCK = 14;
const CH4_BLOCK = 22;

describe('P2 ImpactPlan 与批量采纳 API', () => {
  let ctx: TestContext;
  let server: TestServer;
  let baseUrl: string;
  let firstCh4ProposalId = '';

  beforeAll(async () => {
    ctx = makeTestContext();
    server = await startTestServer(ctx.app);
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    ctx.db.close();
  });

  function addProposal(blockIndex: number, suffix = '（修订）'): Proposal {
    const document = getDocument(ctx.db, ctx.documentId);
    const block = document.paragraphs[blockIndex];
    const proposal = createProposalsFromDrafts(ctx.db, {
      documentId: document.id,
      runId: null,
      baseRevision: document.revision,
      drafts: [
        {
          paragraphId: block.id,
          paragraphIndex: block.index,
          chapterTitle: block.chapterTitle,
          quote: block.text.slice(0, 40),
          oldText: block.text,
          newText: `${block.text}${suffix}`,
          reason: '测试提案',
          citations: [],
        },
      ],
      model: 'mock',
      provider: 'mock',
      backend: 'mock',
      tier: 'review',
      actor: 'test',
    })[0];
    return proposal;
  }

  async function fetchDocument(): Promise<Document> {
    const res = await api<{ document: Document }>(baseUrl, `/api/documents/${ctx.documentId}`);
    expect(res.status).toBe(200);
    return res.body.document;
  }

  async function createPlan(payload: unknown = {}): Promise<ImpactPlan> {
    const res = await jsonApi<PlanResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/impact-plan`,
      payload,
    );
    expect(res.status).toBe(201);
    return res.body.plan;
  }

  it('按提案目标段落计算影响章节/图表/功能，并落库可读取', async () => {
    const proposalCh3 = addProposal(CH3_BLOCK);
    const proposalCh4 = addProposal(CH4_BLOCK);
    firstCh4ProposalId = proposalCh4.id;

    const plan = await createPlan({ trigger: '  审阅第三章  ' });
    expect(plan.documentId).toBe(ctx.documentId);
    expect(plan.baseRevision).toBe(1);
    expect(plan.trigger).toBe('审阅第三章');
    expect(plan.executedAt).toBeNull();

    // 章节：按 chapterIndex 升序聚合，标题来自文档派生段落块。
    expect(plan.affected.chapters.map((chapter) => chapter.chapterIndex)).toEqual([2, 3]);
    expect(plan.affected.chapters[0]).toMatchObject({
      chapterTitle: '第三章 功能拆解与实施路径',
      paragraphCount: 1,
    });
    expect(plan.affected.chapters[0].paragraphIds).toEqual([proposalCh3.paragraphId]);
    expect(plan.affected.chapters[1].chapterTitle).toBe('第四章 预期成效与保障措施');

    // 提案快照按创建顺序。
    expect(plan.affected.proposals.map((proposal) => proposal.id)).toEqual([
      proposalCh3.id,
      proposalCh4.id,
    ]);

    // 图表：两张演示图 chapterRef 均命中第三章。
    expect(plan.affected.diagrams.length).toBe(2);
    for (const item of plan.affected.diagrams) {
      expect(item.reason).toContain('第三章 功能拆解与实施路径');
    }

    // 功能：3 条关联第三章 + 1 条关联第四章。
    expect(plan.affected.featureSpecs.length).toBe(4);
    const chapterRefs = plan.affected.featureSpecs.map((item) => item.feature.chapterRef);
    expect(chapterRefs.filter((ref) => ref === '第三章 功能拆解与实施路径')).toHaveLength(3);
    expect(chapterRefs.filter((ref) => ref === '第四章 预期成效与保障措施')).toHaveLength(1);

    const fetched = await api<PlanResponse>(baseUrl, `/api/impact-plans/${plan.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.plan).toEqual(plan);
  });

  it('默认只纳入 proposed/revised 提案；绑定 reversion 落后的图表也会被标记', async () => {
    // 采纳一条提案：文档 revision 推进到 2，演示图绑定仍为 revision 1（落后）。
    const ch3Proposal = addProposal(CH3_BLOCK, '（第二章外修订）');
    const accepted = await jsonApi<AcceptResponse>(
      baseUrl,
      'POST',
      `/api/proposals/${ch3Proposal.id}/accept`,
      { reviewer: '审阅人' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.document.revision).toBe(2);

    const remaining = addProposal(CH4_BLOCK);
    const plan = await createPlan();
    expect(plan.baseRevision).toBe(2);
    // 已采纳/冲突的提案不再纳入默认计划；仍处于 proposed 的第四章提案会保留。
    const plannedIds = plan.affected.proposals.map((proposal) => proposal.id);
    expect(plannedIds).toEqual([firstCh4ProposalId, remaining.id]);
    expect(plannedIds).not.toContain(ch3Proposal.id);
    expect(plan.affected.chapters.map((chapter) => chapter.chapterTitle)).toEqual([
      '第四章 预期成效与保障措施',
    ]);
    // 图表绑定 revision 1 < 当前 revision 2 → 全部标记为需同步。
    expect(plan.affected.diagrams.length).toBe(2);
    for (const item of plan.affected.diagrams) {
      expect(item.reason).toContain('落后于当前 revision 2');
    }
  });

  it('proposalIds 校验：不存在或跨文档的提案 → 400；文档/计划不存在 → 404', async () => {
    const missingProposal = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/impact-plan`,
      { proposalIds: ['prop_not_exist'] },
    );
    expect(missingProposal.status).toBe(400);
    expect(missingProposal.body.error.code).toBe('validation_error');

    // 另一个项目文档下的提案不能进入本计划。
    const other = await jsonApi<ProjectResponse>(baseUrl, 'POST', '/api/projects', {
      name: '另一个提案项目',
    });
    const otherDocument = getDocument(ctx.db, other.body.project.documentId);
    const otherProposal = createProposalsFromDrafts(ctx.db, {
      documentId: otherDocument.id,
      runId: null,
      baseRevision: otherDocument.revision,
      drafts: [
        {
          paragraphId: otherDocument.paragraphs[0].id,
          paragraphIndex: 0,
          chapterTitle: otherDocument.paragraphs[0].chapterTitle,
          quote: '',
          oldText: '',
          newText: '另一个项目的修订',
          reason: '测试',
          citations: [],
        },
      ],
      model: 'mock',
      provider: 'mock',
      backend: 'mock',
      tier: 'review',
      actor: 'test',
    })[0];

    const crossDoc = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/impact-plan`,
      { proposalIds: [otherProposal.id] },
    );
    expect(crossDoc.status).toBe(400);
    expect(crossDoc.body.error.code).toBe('validation_error');

    const missingDoc = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/documents/doc_not_exist/impact-plan',
      {},
    );
    expect(missingDoc.status).toBe(404);

    const missingPlan = await api<ErrorResponse>(baseUrl, '/api/impact-plans/imp_not_exist');
    expect(missingPlan.status).toBe(404);
    expect(missingPlan.body.error.code).toBe('not_found');
  });

  it('execute 批量采纳计划内提案并写入 executedAt；计划外提案 → 400', async () => {
    const pending = addProposal(CH4_BLOCK, '（执行修订）');
    const plan = await createPlan({ proposalIds: [pending.id] });
    expect(plan.affected.proposals.map((proposal) => proposal.id)).toEqual([pending.id]);

    const executed = await jsonApi<ExecuteResponse>(
      baseUrl,
      'POST',
      `/api/impact-plans/${plan.id}/execute`,
      { reviewer: '执行人' },
    );
    expect(executed.status).toBe(200);
    expect(executed.body.plan.executedAt).not.toBeNull();
    expect(executed.body.batch.results).toHaveLength(1);
    expect(executed.body.batch.results[0]).toMatchObject({
      id: pending.id,
      ok: true,
      status: 'accepted',
      error: null,
    });
    const proposalAfter = await api<ProposalResponse>(baseUrl, `/api/proposals/${pending.id}`);
    expect(proposalAfter.body.proposal.status).toBe('accepted');
    expect(executed.body.batch.document.revision).toBe(3);

    // 计划内没有该提案 id 时拒绝执行。
    const emptyPlan = await createPlan();
    const outside = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/impact-plans/${emptyPlan.id}/execute`,
      { proposalIds: [pending.id] },
    );
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('validation_error');

    const missingPlan = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/impact-plans/imp_not_exist/execute',
      {},
    );
    expect(missingPlan.status).toBe(404);
  });

  it('批量采纳混合状态：成功/冲突/不存在/跨文档/重复 id 均逐条记录，不阻断整体', async () => {
    const first = addProposal(CH3_BLOCK, '（批量 A）');
    const second = addProposal(CH3_BLOCK, '（批量 B）');
    const third = addProposal(CH3_OTHER_BLOCK, '（批量 C）');

    const other = await jsonApi<ProjectResponse>(baseUrl, 'POST', '/api/projects', {
      name: '批量采纳的另一个项目',
    });
    const otherDocument = getDocument(ctx.db, other.body.project.documentId);
    const crossProposal = createProposalsFromDrafts(ctx.db, {
      documentId: otherDocument.id,
      runId: null,
      baseRevision: otherDocument.revision,
      drafts: [
        {
          paragraphId: otherDocument.paragraphs[0].id,
          paragraphIndex: 0,
          chapterTitle: otherDocument.paragraphs[0].chapterTitle,
          quote: '',
          oldText: '',
          newText: '跨文档修订',
          reason: '测试',
          citations: [],
        },
      ],
      model: 'mock',
      provider: 'mock',
      backend: 'mock',
      tier: 'review',
      actor: 'test',
    })[0];

    const before = await fetchDocument();
    const res = await jsonApi<BatchAcceptResult>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/proposals/batch-accept`,
      {
        ids: [first.id, second.id, 'prop_missing', crossProposal.id, first.id, third.id],
        reviewer: '批量审阅人',
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(6);

    // A 成功采纳。
    expect(res.body.results[0]).toMatchObject({ id: first.id, ok: true, status: 'accepted', error: null });
    // B 与 A 锚定同一段落，A 采纳后 B 被标记冲突，单条失败不阻断。
    expect(res.body.results[1].ok).toBe(false);
    expect(res.body.results[1].status).toBe('conflicted');
    expect(res.body.results[1].error).toBeTruthy();
    // 不存在的提案。
    expect(res.body.results[2]).toMatchObject({ id: 'prop_missing', ok: false, status: null });
    // 跨文档提案。
    expect(res.body.results[3].ok).toBe(false);
    expect(res.body.results[3].error).toContain('不属于该文档');
    // 重复 id 被跳过。
    expect(res.body.results[4].ok).toBe(false);
    expect(res.body.results[4].status).toBe('accepted');
    // C 锚定其它段落，安全重基后成功。
    expect(res.body.results[5]).toMatchObject({ id: third.id, ok: true, status: 'accepted', error: null });

    // 返回最新文档：两条成功采纳各 +1 revision。
    expect(res.body.document.revision).toBe(before.revision + 2);
    const current = await fetchDocument();
    expect(current.revision).toBe(res.body.document.revision);
    const targetFirst = current.paragraphs.find((block) => block.id === first.paragraphId);
    expect(targetFirst?.text).toBe(first.newText);
    const targetThird = current.paragraphs.find((block) => block.id === third.paragraphId);
    expect(targetThird?.text).toBe(third.newText);

    const conflicted = await api<ProposalResponse>(baseUrl, `/api/proposals/${second.id}`);
    expect(conflicted.body.proposal.status).toBe('conflicted');
  });

  it('批量采纳参数校验：ids 为空/文档不存在', async () => {
    const empty = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      `/api/documents/${ctx.documentId}/proposals/batch-accept`,
      { ids: [] },
    );
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_error');

    const missingDoc = await jsonApi<ErrorResponse>(
      baseUrl,
      'POST',
      '/api/documents/doc_not_exist/proposals/batch-accept',
      { ids: ['prop_x'] },
    );
    expect(missingDoc.status).toBe(404);
  });
});
