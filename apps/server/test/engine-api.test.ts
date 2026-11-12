/**
 * 提案引擎端到端（内存 DB + 临时 HTTP 服务）测试：
 * 状态接口、异步生成 Run、故障注入、数据分级阻断、采纳/拒绝/讨论状态机、
 * hash 冲突、安全重基、读回校验、冲突标记联动。全程不访问真实模型/网络。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyParagraphText,
  hashText,
} from '../src/domain/paragraphs.js';
import * as proposalService from '../src/services/proposalService.js';
import { getDocument, replaceDocumentContent } from '../src/services/documentsService.js';
import type { Document, Proposal, Run, StatusResponse } from '../src/types.js';
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

const PROMPT = '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议';

async function generateMock(
  baseUrl: string,
  documentId: string,
  extra: Record<string, unknown> = {},
) {
  return jsonApi<{ run: Run }>(baseUrl, 'POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: PROMPT,
    backend: 'mock',
    tier: 'review',
    count: 5,
    ...extra,
  });
}

async function waitRun(baseUrl: string, runId: string, timeoutMs = 10_000): Promise<Run> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await api<{ run: Run }>(baseUrl, `/api/runs/${runId}`);
    expect(result.status).toBe(200);
    if (['succeeded', 'failed', 'cancelled'].includes(result.body.run.status)) {
      return result.body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待运行 ${runId} 超时`);
}

async function proposalsOf(baseUrl: string, documentId: string): Promise<Proposal[]> {
  const result = await api<{ proposals: Proposal[] }>(
    baseUrl,
    `/api/documents/${documentId}/proposals`,
  );
  expect(result.status).toBe(200);
  return result.body.proposals;
}

async function generateSucceeded(
  baseUrl: string,
  documentId: string,
): Promise<{ run: Run; proposals: Proposal[] }> {
  const response = await generateMock(baseUrl, documentId);
  expect(response.status).toBe(202);
  const run = await waitRun(baseUrl, response.body.run.id);
  expect(run.status).toBe('succeeded');
  const proposals = await proposalsOf(baseUrl, documentId);
  return { run, proposals };
}

function referenceIds(ctx: TestContext): string[] {
  const rows = ctx.db
    .prepare('SELECT id FROM references_docs WHERE project_id = ?')
    .all(ctx.projectId) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

describe('GET /api/status（安全状态展示）', () => {
  it('返回 providers/backends/dataPolicy/faultInjectionEnabled/mockMode，且不暴露密钥或完整 baseUrl', async () => {
    const { baseUrl } = await setup();
    const result = await api<StatusResponse>(baseUrl, '/api/status');
    expect(result.status).toBe(200);
    expect(result.body.app.mockMode).toBe(false);
    expect(result.body.faultInjectionEnabled).toBe(true);
    expect(result.body.backends.map((backend) => backend.id)).toEqual([
      'dsh',
      'mock',
      'codex',
    ]);
    const dsh = result.body.backends.find((backend) => backend.id === 'dsh');
    const mock = result.body.backends.find((backend) => backend.id === 'mock');
    const codex = result.body.backends.find((backend) => backend.id === 'codex');
    expect(dsh?.available).toBe(false);
    expect(dsh?.mock).toBe(false);
    expect(mock?.available).toBe(true);
    expect(mock?.mock).toBe(true);
    expect(codex?.available).toBe(false);
    const providerIds = result.body.providers.map((provider) => provider.id);
    expect(providerIds).toContain('openai-compatible');
    expect(providerIds).toContain('deepseek-anthropic');
    expect(providerIds).toContain('mock');
    for (const provider of result.body.providers) {
      expect(provider.baseUrl).toBeNull();
    }
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toMatch(/sk-[a-z0-9]/i);
    expect(serialized).not.toMatch(/api[_-]?key["':]/i);
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
    expect(result.body.dataPolicy.defaultLevel).toBe('internal');
    expect(result.body.dataPolicy.externalProvidersAllowedFor).toEqual(['public', 'internal']);
  });
});

describe('生成：异步 Run + Mock 确定性 5 条提案', () => {
  it('POST generate → 202 {run}，轮询 GET /runs/:id 到 succeeded，落库 5 条 proposed 提案', async () => {
    const { ctx, baseUrl } = await setup();
    const response = await generateMock(baseUrl, ctx.documentId);
    expect(response.status).toBe(202);
    expect(['queued', 'running']).toContain(response.body.run.status);
    expect(response.body.run.type).toBe('proposal_generation');

    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(run.error).toBeNull();
    expect(run.backend).toBe('mock');
    expect(run.provider).toBe('mock');
    expect(run.model).toBe('mock-proposal-v1');
    expect(run.tier).toBe('review');
    expect(run.tokensIn).toBeGreaterThan(0);
    expect(run.tokensOut).toBeGreaterThan(0);
    expect(run.events.length).toBeGreaterThanOrEqual(3);
    const eventText = run.events.map((event) => event.message).join('\n');
    expect(eventText).toContain('模拟');
    expect(eventText).toContain('生成');
    expect(run.events.map((event) => event.seq)).toEqual(
      run.events.map((_event, index) => index + 1),
    );
    expect(JSON.stringify(run)).not.toMatch(/sk-[a-z0-9]/i);

    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    expect(proposals).toHaveLength(5);
    const document = getDocument(ctx.db, ctx.documentId);
    const validReferenceIds = new Set(referenceIds(ctx));
    const paragraphIds = new Set<string>();
    for (const proposal of proposals) {
      expect(proposal.status).toBe('proposed');
      expect(proposal.runId).toBe(run.id);
      expect(proposal.backend).toBe('mock');
      expect(proposal.provider).toBe('mock');
      expect(proposal.model).toBe('mock-proposal-v1');
      expect(proposal.tier).toBe('review');
      expect(proposal.baseRevision).toBe(document.revision);
      expect(proposal.baseHash).toBe(hashText(proposal.oldText));
      expect(proposal.oldText).toBe(proposal.quote);
      expect(proposal.newText).not.toBe(proposal.oldText);
      expect(proposal.citations.length).toBeGreaterThan(0);
      for (const citation of proposal.citations) {
        expect(validReferenceIds.has(citation.referenceId)).toBe(true);
        expect(citation.locator.length).toBeGreaterThan(0);
        expect(citation.excerpt.length).toBeGreaterThan(0);
      }
      const block = document.paragraphs.find((item) => item.id === proposal.paragraphId);
      expect(block).toBeDefined();
      expect(block?.chapterIndex).toBe(2);
      expect(block?.type).toBe('paragraph');
      expect(block?.index).toBe(proposal.paragraphIndex);
      expect(proposal.chapterTitle).toContain('第三章');
      paragraphIds.add(proposal.paragraphId);
    }
    // 段落锚点唯一（lead 要求：重复 paragraphId 会导致采纳后误判冲突）
    expect(paragraphIds.size).toBe(5);
  });

  it('未配置真实模型凭据时 dsh 后端返回 400 credential_missing 且不创建 Run', async () => {
    const { ctx, baseUrl } = await setup();
    const response = await generateMock(baseUrl, ctx.documentId, { backend: 'dsh' });
    expect(response.status).toBe(400);
    const body = response.body as unknown as { error: { code: string } };
    expect(body.error.code).toBe('credential_missing');
    const count = ctx.db.prepare('SELECT COUNT(*) AS total FROM runs').get() as unknown as {
      total: number;
    };
    expect(count.total).toBe(0);
    expect(await proposalsOf(baseUrl, ctx.documentId)).toHaveLength(0);
  });

  it('请求体校验：缺少 prompt / count 越界 → 400 validation_error', async () => {
    const { ctx, baseUrl } = await setup();
    const missingPrompt = await jsonApi(baseUrl, 'POST', `/api/documents/${ctx.documentId}/proposals/generate`, {
      backend: 'mock',
      count: 5,
    });
    expect(missingPrompt.status).toBe(400);
    expect((missingPrompt.body as unknown as { error: { code: string } }).error.code).toBe(
      'validation_error',
    );
    const invalidCount = await generateMock(baseUrl, ctx.documentId, { count: 99 });
    expect(invalidCount.status).toBe(400);
  });
});

describe('故障注入（仅 demo，config.faultInjection 开启时生效）', () => {
  const cases: Array<[string, string]> = [
    ['rate_limit', 'model_rate_limited'],
    ['server_error', 'model_unavailable'],
    ['network', 'model_unavailable'],
    ['timeout', 'model_timeout'],
    ['data_policy', 'data_policy_blocked'],
  ];

  it('fault 分别映射为契约错误码，Run 标 failed 且不落提案、不改文档', async () => {
    const { ctx, baseUrl } = await setup();
    for (const [fault, expectedCode] of cases) {
      const response = await generateMock(baseUrl, ctx.documentId, { fault });
      expect(response.status).toBe(202);
      const run = await waitRun(baseUrl, response.body.run.id);
      expect(run.status).toBe('failed');
      expect(run.error?.code).toBe(expectedCode);
      expect(run.retryReason).toBe(`fault_injected:${fault}`);
      expect(run.events.some((event) => JSON.stringify(event.data ?? {}).includes(fault))).toBe(
        true,
      );
    }
    expect(await proposalsOf(baseUrl, ctx.documentId)).toHaveLength(0);
    expect(getDocument(ctx.db, ctx.documentId).revision).toBe(1);
  });
});

describe('数据分级（secret 一律阻断外部模型）', () => {
  it('secret 项目 + dsh → 403 data_policy_blocked，落 failed Run，无提案、文档不变；mock 仍可用', async () => {
    const { ctx, baseUrl } = await setup();
    ctx.db
      .prepare("UPDATE projects SET data_level = 'secret' WHERE id = ?")
      .run(ctx.projectId);
    const response = await generateMock(baseUrl, ctx.documentId, { backend: 'dsh' });
    expect(response.status).toBe(403);
    const body = response.body as unknown as {
      error: { code: string; details: { run: Run } };
    };
    expect(body.error.code).toBe('data_policy_blocked');
    expect(body.error.details.run.status).toBe('failed');
    expect(body.error.details.run.error?.code).toBe('data_policy_blocked');
    expect(await proposalsOf(baseUrl, ctx.documentId)).toHaveLength(0);
    expect(getDocument(ctx.db, ctx.documentId).revision).toBe(1);

    // 离线 mock 不发送外部网络，secret 项目允许演示（不产生外发）。
    const mockResponse = await generateMock(baseUrl, ctx.documentId, { backend: 'mock' });
    expect(mockResponse.status).toBe(202);
    const mockRun = await waitRun(baseUrl, mockResponse.body.run.id);
    expect(mockRun.status).toBe('succeeded');
  });
});

describe('采纳（服务端权威写入 + 读回校验）', () => {
  it('采纳首条：文档 revision+1，仅目标段落变为 newText，提案 accepted 并写事件；再次采纳 409', async () => {
    const { ctx, baseUrl } = await setup();
    const before = getDocument(ctx.db, ctx.documentId);
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[0];

    const response = await jsonApi<{ proposal: Proposal; document: Document }>(
      baseUrl,
      'POST',
      `/api/proposals/${target.id}/accept`,
      { reviewer: '审阅人A' },
    );
    expect(response.status).toBe(200);
    expect(response.body.proposal.status).toBe('accepted');
    expect(response.body.proposal.reviewer).toBe('审阅人A');
    expect(response.body.proposal.decidedAt).not.toBeNull();
    expect(response.body.proposal.baseRevision).toBe(before.revision + 1);
    const afterDocument = response.body.document;
    expect(afterDocument.revision).toBe(before.revision + 1);
    const targetAfter = afterDocument.paragraphs.find(
      (block) => block.id === target.paragraphId,
    );
    expect(targetAfter?.text).toBe(target.newText);
    // 其它段落完全不变
    for (const block of before.paragraphs) {
      if (block.id === target.paragraphId) continue;
      const current = afterDocument.paragraphs.find((item) => item.id === block.id);
      expect(current?.text).toBe(block.text);
      expect(current?.hash).toBe(block.hash);
    }
    const events = proposalService.listProposalEvents(ctx.db, target.id);
    expect(events.at(-1)?.toStatus).toBe('accepted');
    expect(events.at(-1)?.actor).toBe('审阅人A');

    const others = (await proposalsOf(baseUrl, ctx.documentId)).filter(
      (proposal) => proposal.id !== target.id,
    );
    expect(others.every((proposal) => proposal.status === 'proposed')).toBe(true);

    const again = await jsonApi(baseUrl, 'POST', `/api/proposals/${target.id}/accept`, {});
    expect(again.status).toBe(409);
    expect((again.body as unknown as { error: { code: string } }).error.code).toBe(
      'proposal_state_invalid',
    );
  });

  it('仅全局 revision 变化、目标段落 hash 未变 → 安全重基后采纳成功', async () => {
    const { ctx, baseUrl } = await setup();
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[0];

    const before = getDocument(ctx.db, ctx.documentId);
    const otherParagraph = before.paragraphs.find(
      (block) => block.chapterIndex === 0 && block.type === 'paragraph',
    );
    expect(otherParagraph).toBeDefined();
    const edited = applyParagraphText(
      before.contentJson,
      otherParagraph!.id,
      `${otherParagraph!.text}（人工修订，不影响第三章）`,
    );
    replaceDocumentContent(ctx.db, ctx.documentId, edited.contentJson, { actor: 'human' });
    expect(getDocument(ctx.db, ctx.documentId).revision).toBe(before.revision + 1);

    const response = await jsonApi<{ proposal: Proposal; document: Document }>(
      baseUrl,
      'POST',
      `/api/proposals/${target.id}/accept`,
      { reviewer: '审阅人B' },
    );
    expect(response.status).toBe(200);
    expect(response.body.proposal.status).toBe('accepted');
    expect(response.body.document.revision).toBe(before.revision + 2);
    const targetAfter = response.body.document.paragraphs.find(
      (block) => block.id === target.paragraphId,
    );
    expect(targetAfter?.text).toBe(target.newText);
    const events = proposalService.listProposalEvents(ctx.db, target.id);
    expect(events.at(-1)?.note).toContain('安全重基');
  });

  it('目标段落 hash 已变化 → 409 proposal_conflicted，提案标 conflicted，禁止覆盖', async () => {
    const { ctx, baseUrl } = await setup();
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[0];

    const before = getDocument(ctx.db, ctx.documentId);
    const manualText = `${before.paragraphs.find((block) => block.id === target.paragraphId)?.text}（人工改写）`;
    const edited = applyParagraphText(before.contentJson, target.paragraphId, manualText);
    replaceDocumentContent(ctx.db, ctx.documentId, edited.contentJson, { actor: 'human' });

    const response = await jsonApi(baseUrl, 'POST', `/api/proposals/${target.id}/accept`, {});
    expect(response.status).toBe(409);
    const body = response.body as unknown as {
      error: { code: string; details: { proposal: Proposal } };
    };
    expect(body.error.code).toBe('proposal_conflicted');
    expect(body.error.details.proposal.status).toBe('conflicted');
    expect(body.error.details.proposal.conflictReason).not.toBeNull();

    const stored = await api<{ proposal: Proposal }>(baseUrl, `/api/proposals/${target.id}`);
    expect(stored.body.proposal.status).toBe('conflicted');
    const documentAfter = getDocument(ctx.db, ctx.documentId);
    expect(documentAfter.revision).toBe(2);
    expect(
      documentAfter.paragraphs.find((block) => block.id === target.paragraphId)?.text,
    ).toBe(manualText);
    const events = proposalService.listProposalEvents(ctx.db, target.id);
    expect(events.at(-1)?.toStatus).toBe('conflicted');
  });

  it('拒绝：→ rejected，文档不变', async () => {
    const { ctx, baseUrl } = await setup();
    const before = getDocument(ctx.db, ctx.documentId);
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[1];

    const response = await jsonApi<{ proposal: Proposal }>(
      baseUrl,
      'POST',
      `/api/proposals/${target.id}/reject`,
      { reviewer: '审阅人C', note: '依据不足' },
    );
    expect(response.status).toBe(200);
    expect(response.body.proposal.status).toBe('rejected');
    expect(response.body.proposal.reviewer).toBe('审阅人C');
    expect(getDocument(ctx.db, ctx.documentId).revision).toBe(before.revision);
    const events = proposalService.listProposalEvents(ctx.db, target.id);
    expect(events.at(-1)?.toStatus).toBe('rejected');
    expect(events.at(-1)?.note).toBe('依据不足');
  });
});

describe('继续讨论（异步 Run，只更新该条）', () => {
  it('discuss → 202，轮询成功；该条 revised/discussionCount+1，文档与其它提案不变', async () => {
    const { ctx, baseUrl } = await setup();
    const before = getDocument(ctx.db, ctx.documentId);
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[2];

    const response = await jsonApi<{ run: Run }>(
      baseUrl,
      'POST',
      `/api/proposals/${target.id}/discuss`,
      { message: '请补充试点范围与指标口径', backend: 'mock', tier: 'review' },
    );
    expect(response.status).toBe(202);
    expect(response.body.run.type).toBe('discussion');
    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(run.tokensOut).toBeGreaterThan(0);

    const updated = await api<{ proposal: Proposal }>(baseUrl, `/api/proposals/${target.id}`);
    expect(updated.body.proposal.status).toBe('revised');
    expect(updated.body.proposal.discussionCount).toBe(1);
    expect(updated.body.proposal.newText).not.toBe(target.newText);
    expect(updated.body.proposal.reason).not.toBe(target.reason);
    expect(getDocument(ctx.db, ctx.documentId).revision).toBe(before.revision);

    const all = await proposalsOf(baseUrl, ctx.documentId);
    for (const proposal of all) {
      if (proposal.id === target.id) continue;
      expect(proposal.status).toBe('proposed');
      expect(proposal.newText).not.toContain('讨论意见');
    }
    const events = proposalService.listProposalEvents(ctx.db, target.id);
    expect(events.at(-1)?.toStatus).toBe('revised');
  });

  it('已采纳提案不允许讨论（409 proposal_state_invalid）；未配置凭据的 dsh 讨论 400 credential_missing', async () => {
    const { ctx, baseUrl } = await setup();
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[0];
    await jsonApi(baseUrl, 'POST', `/api/proposals/${target.id}/accept`, {});
    const invalid = await jsonApi(baseUrl, 'POST', `/api/proposals/${target.id}/discuss`, {
      message: '继续讨论',
      backend: 'mock',
    });
    expect(invalid.status).toBe(409);
    expect((invalid.body as unknown as { error: { code: string } }).error.code).toBe(
      'proposal_state_invalid',
    );

    const credentialMissing = await jsonApi(
      baseUrl,
      'POST',
      `/api/proposals/${proposals[1].id}/discuss`,
      { message: '继续讨论', backend: 'dsh' },
    );
    expect(credentialMissing.status).toBe(400);
    expect(
      (credentialMissing.body as unknown as { error: { code: string } }).error.code,
    ).toBe('credential_missing');
  });
});

describe('markConflictedProposalsForContentChange（documents 路由联动）', () => {
  it('目标段落文本变化 → 仅该提案标 conflicted 并写事件', async () => {
    const { ctx, baseUrl } = await setup();
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const target = proposals[0];
    const document = getDocument(ctx.db, ctx.documentId);
    const newBlocks = document.paragraphs.map((block) =>
      block.id === target.paragraphId
        ? { ...block, text: `${block.text}（人工改动）`, hash: hashText(`${block.text}（人工改动）`) }
        : block,
    );
    const marked = proposalService.markConflictedProposalsForContentChange(
      ctx.db,
      ctx.documentId,
      document.paragraphs,
      newBlocks,
    );
    expect(marked.map((proposal) => proposal.id)).toEqual([target.id]);
    const stored = proposalService.getProposal(ctx.db, target.id);
    expect(stored.status).toBe('conflicted');
    expect(stored.conflictReason).not.toBeNull();
    const events = proposalService.listProposalEvents(ctx.db, target.id);
    expect(events.at(-1)?.toStatus).toBe('conflicted');
  });

  it('只改其它段落 → 提案保持 proposed（返回空数组）', async () => {
    const { ctx, baseUrl } = await setup();
    const { proposals } = await generateSucceeded(baseUrl, ctx.documentId);
    const document = getDocument(ctx.db, ctx.documentId);
    const unrelated = document.paragraphs.find(
      (block) => block.chapterIndex === 0 && block.type === 'paragraph',
    );
    const newBlocks = document.paragraphs.map((block) =>
      block.id === unrelated?.id
        ? { ...block, text: `${block.text}（人工改动）`, hash: hashText(`${block.text}（人工改动）`) }
        : block,
    );
    const marked = proposalService.markConflictedProposalsForContentChange(
      ctx.db,
      ctx.documentId,
      document.paragraphs,
      newBlocks,
    );
    expect(marked).toHaveLength(0);
    for (const proposal of proposals) {
      expect(proposalService.getProposal(ctx.db, proposal.id).status).toBe('proposed');
    }
  });
});

describe('运行记录接口', () => {
  it('未知 Run → 404 not_found；已结束 Run 取消为幂等返回', async () => {
    const { ctx, baseUrl } = await setup();
    const missing = await api(baseUrl, '/api/runs/run_not_exists');
    expect(missing.status).toBe(404);
    expect((missing.body as unknown as { error: { code: string } }).error.code).toBe(
      'not_found',
    );
    const { run } = await generateSucceeded(baseUrl, ctx.documentId);
    const cancel = await jsonApi<{ run: Run }>(baseUrl, 'POST', `/api/runs/${run.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.run.status).toBe('succeeded');
    expect(ctx.db.prepare('SELECT COUNT(*) AS total FROM proposals WHERE document_id = ?').get(ctx.documentId)).toBeTruthy();
  });

  it('GET /api/projects/:id/runs 返回按创建时间倒序的运行列表；未知项目 404', async () => {
    const { ctx, baseUrl } = await setup();
    const { run } = await generateSucceeded(baseUrl, ctx.documentId);
    const list = await api<{ runs: Run[] }>(
      baseUrl,
      `/api/projects/${ctx.projectId}/runs?limit=5`,
    );
    expect(list.status).toBe(200);
    expect(list.body.runs.length).toBeGreaterThanOrEqual(1);
    expect(list.body.runs[0].id).toBe(run.id);
    const missing = await api(baseUrl, '/api/projects/prj_not_exists/runs');
    expect(missing.status).toBe(404);
    expect((missing.body as unknown as { error: { code: string } }).error.code).toBe(
      'not_found',
    );
  });
});
