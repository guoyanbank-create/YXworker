/**
 * P1-3 provider 三选 + 引用过滤注入测试：
 * - provider=openai-compatible|deepseek-anthropic|mock；未配置 → 400 credential_missing；
 * - 执行器与提供方严格分离（PRODUCT_SPEC §3）：backend=mock 强制 provider=mock；
 *   显式 backend=dsh + provider=mock 时 backend 保持 dsh，但 Run/提案/事件必须以 provider=mock、
 *   model=mock-*、mock=true 标注“模拟”，绝不冒充真实模型；
 * - referenceIds / referenceSectionIds 只注入选中材料，且必须属于本项目（400 validation_error）；
 * - 真实 provider 用注入的全局 fetch 假响应验证 run/提案记录真实 provider/model（不访问网络、不落密钥）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { ensureSeed, ensureSeedExtras } from '../src/seed/seed.js';
import { createReference } from '../src/services/referencesService.js';
import type {
  Document,
  Proposal,
  Reference,
  ReferenceSection,
  Run,
  StatusResponse,
} from '../src/types.js';
import {
  api,
  jsonApi,
  makeTestContext,
  startTestServer,
  type TestContext,
  type TestServer,
} from './helpers.js';

const API_KEY = 'sk-test-SECRET-DO-NOT-LEAK';
const GATEWAY_BASE_URL = 'https://gateway.example.com/v1';
const ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const PROMPT = '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议';

interface CustomContext {
  db: Db;
  app: Express;
  projectId: string;
  documentId: string;
}

const contexts: Array<TestContext | CustomContext> = [];
const servers: TestServer[] = [];

async function serve(ctx: TestContext | CustomContext): Promise<string> {
  const server = await startTestServer(ctx.app);
  contexts.push(ctx);
  servers.push(server);
  return server.baseUrl;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) await server.close();
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

/** 已配置真实凭据的测试上下文（假值；provider 调用由测试注入的 fetch 拦截）。 */
function makeConfiguredContext(provider: 'openai' | 'anthropic'): CustomContext {
  const db = openDb(':memory:');
  const seeded = ensureSeed(db);
  ensureSeedExtras(db);
  const testConfig = {
    ...config,
    llm: {
      ...config.llm,
      baseUrl: provider === 'openai' ? GATEWAY_BASE_URL : '',
      apiKey: provider === 'openai' ? API_KEY : '',
      model: 'deepseek-flash',
      modelPro: 'deepseek-v4-pro',
      tiers: { draft: 'deepseek-flash', review: 'deepseek-flash', long_reasoning: 'deepseek-v4-pro' },
    },
    deepseek: {
      ...config.deepseek,
      anthropicBaseUrl: ANTHROPIC_BASE_URL,
      apiKey: provider === 'anthropic' ? API_KEY : '',
      model: 'deepseek-flash',
    },
    faultInjection: true,
    seedDemo: false,
  };
  Object.defineProperty(testConfig, 'llmConfigured', {
    get: () => provider === 'openai' || provider === 'anthropic',
  });
  const app = createApp({ db, config: testConfig });
  return { db, app, projectId: seeded.projectId, documentId: seeded.documentId };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 拦截外部 provider 请求：命中 127.0.0.1 的真实请求（测试 HTTP 服务）透传，
 * 其余请求记录并返回 handler 的假响应。
 */
function stubProviderFetch(handler: (url: string) => Response | Promise<Response>): FetchCall[] {
  const realFetch = globalThis.fetch.bind(globalThis);
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('127.0.0.1')) return realFetch(input as string | URL | Request, init);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url));
  });
  return calls;
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
  const result = await api<{ proposals: Proposal[] }>(baseUrl, `/api/documents/${documentId}/proposals`);
  expect(result.status).toBe(200);
  return result.body.proposals;
}

async function referencesOf(baseUrl: string, projectId: string): Promise<Reference[]> {
  const result = await api<{ references: Reference[] }>(baseUrl, `/api/projects/${projectId}/references`);
  expect(result.status).toBe(200);
  return result.body.references;
}

async function sectionsOf(
  baseUrl: string,
  projectId: string,
  referenceId: string,
): Promise<ReferenceSection[]> {
  const result = await api<{ sections: ReferenceSection[] }>(
    baseUrl,
    `/api/projects/${projectId}/references/${referenceId}/sections`,
  );
  expect(result.status).toBe(200);
  return result.body.sections;
}

async function generate(
  baseUrl: string,
  documentId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: { run: Run; error?: { code: string; message: string } } }> {
  return jsonApi(baseUrl, 'POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: PROMPT,
    count: 5,
    ...extra,
  });
}

async function runCount(ctx: TestContext | CustomContext): Promise<number> {
  const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as unknown as { n: number };
  return Number(row.n);
}

/* ------------------------------------------------------------------ *
 * 未配置凭据 / 参数校验
 * ------------------------------------------------------------------ */

describe('P1 provider 选择：凭据与参数校验', () => {
  it('选择未配置的真实 provider → 400 credential_missing，且不创建 Run/提案', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    for (const provider of ['openai-compatible', 'deepseek-anthropic']) {
      const response = await generate(baseUrl, ctx.documentId, { backend: 'dsh', provider });
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe('credential_missing');
    }
    // 不传 provider 时保持 P0 默认（dsh 未配置 → credential_missing）。
    const defaultResponse = await generate(baseUrl, ctx.documentId, { backend: 'dsh' });
    expect(defaultResponse.status).toBe(400);
    expect(defaultResponse.body.error?.code).toBe('credential_missing');

    expect(await runCount(ctx)).toBe(0);
    expect(await proposalsOf(baseUrl, ctx.documentId)).toHaveLength(0);
  });

  it('provider 不在枚举内 → 400 validation_error', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    const response = await generate(baseUrl, ctx.documentId, { backend: 'dsh', provider: 'unknown-provider' });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('validation_error');
  });
});

/* ------------------------------------------------------------------ *
 * mock 强制语义
 * ------------------------------------------------------------------ */

describe('P1 mock 语义（执行器/提供方分离，不虚报真实模型）', () => {
  it('backend=mock 时即使传真实 provider 也强制 mock provider，运行可成功', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'mock',
      provider: 'openai-compatible',
    });
    expect(response.status).toBe(202);
    expect(response.body.run.backend).toBe('mock');
    expect(response.body.run.provider).toBe('mock');
    expect(response.body.run.model).toBe('mock-proposal-v1');

    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(run.provider).toBe('mock');
    expect(run.events.some((event) => event.message.includes('模拟'))).toBe(true);
    expect(
      run.events.some(
        (event) =>
          typeof event.data === 'object' &&
          event.data !== null &&
          (event.data as { forcedMock?: unknown }).forcedMock === true,
      ),
    ).toBe(true);
    expect(await proposalsOf(baseUrl, ctx.documentId)).toHaveLength(5);

    // 状态接口同样把 mock 标为可选 provider，且不因强制而虚报真实链路。
    const status = await api<StatusResponse>(baseUrl, '/api/status');
    const mockProvider = status.body.providers.find((provider) => provider.id === 'mock');
    expect(mockProvider?.configured).toBe(true);
  });

  it('provider=mock 保持显式 backend=dsh（执行器/提供方分离），模型来源记为 mock', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    // backend 显式 dsh + provider mock：执行器字段保持 dsh，provider/model/事件必须标注 mock。
    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'dsh',
      provider: 'mock',
    });
    expect(response.status).toBe(202);
    expect(response.body.run.backend).toBe('dsh');
    expect(response.body.run.provider).toBe('mock');
    expect(response.body.run.model).toBe('mock-proposal-v1');

    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(run.backend).toBe('dsh');
    expect(run.provider).toBe('mock');
    expect(run.model).toBe('mock-proposal-v1');
    // 事件必须携带 mock=true（UI 据此标注“模拟”，不冒充真实模型）。
    const mockEvent = run.events.find(
      (event) =>
        typeof event.data === 'object' &&
        event.data !== null &&
        (event.data as { mock?: unknown }).mock === true,
    );
    expect(mockEvent).toBeDefined();
    expect(mockEvent?.message).toContain('mock');

    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    expect(proposals).toHaveLength(5);
    for (const proposal of proposals) {
      expect(proposal.backend).toBe('dsh');
      expect(proposal.provider).toBe('mock');
      expect(proposal.model).toBe('mock-proposal-v1');
    }
  });

  it('secret 项目 + backend=dsh + provider=mock：离线 mock 不产生外发，允许运行', async () => {
    const ctx = makeTestContext();
    ctx.db.prepare("UPDATE projects SET data_level = 'secret' WHERE id = ?").run(ctx.projectId);
    const baseUrl = await serve(ctx);
    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'dsh',
      provider: 'mock',
      count: 2,
    });
    expect(response.status).toBe(202);
    expect(response.body.run.backend).toBe('dsh');
    expect(response.body.run.provider).toBe('mock');
    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(await proposalsOf(baseUrl, ctx.documentId)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * 引用过滤注入
 * ------------------------------------------------------------------ */

describe('P1 引用过滤注入（只把选中材料发给模型）', () => {
  it('referenceIds：仅注入选中引用，提案 citations 只来自该引用', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    const references = await referencesOf(baseUrl, ctx.projectId);
    expect(references.length).toBeGreaterThanOrEqual(2);
    const target = references[0];

    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'mock',
      referenceIds: [target.id],
    });
    expect(response.status).toBe(202);
    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');

    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    expect(proposals).toHaveLength(5);
    for (const proposal of proposals) {
      expect(proposal.citations.length).toBeGreaterThan(0);
      for (const citation of proposal.citations) {
        expect(citation.referenceId).toBe(target.id);
      }
    }
  });

  it('referenceSectionIds：只注入选中小节，citation locator 就是该小节', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    const references = await referencesOf(baseUrl, ctx.projectId);
    const reference = references[0];
    const sections = await sectionsOf(baseUrl, ctx.projectId, reference.id);
    expect(sections.length).toBeGreaterThan(1);
    const target = sections[1];

    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'mock',
      count: 1,
      referenceSectionIds: [target.id],
    });
    expect(response.status).toBe(202);
    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');

    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].citations.length).toBeGreaterThan(0);
    for (const citation of proposals[0].citations) {
      expect(citation.referenceId).toBe(reference.id);
      expect(citation.locator).toBe(target.locator);
    }
  });

  it('引用/小节不属于本项目或范围不一致 → 400 validation_error，不创建 Run', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    const references = await referencesOf(baseUrl, ctx.projectId);

    // 另一个项目的引用/小节。
    const projectResponse = await jsonApi<{ project: { id: string } }>(
      baseUrl,
      'POST',
      '/api/projects',
      { name: '引用隔离测试项目' },
    );
    expect(projectResponse.status).toBe(201);
    const otherProjectId = projectResponse.body.project.id;
    const otherReference = await createReference(ctx.db, otherProjectId, {
      filename: 'other-project.md',
      buffer: Buffer.from('## 第 1 节 其它项目\n其它项目专用内容。', 'utf8'),
    });
    const otherSections = await sectionsOf(baseUrl, otherProjectId, otherReference.id);

    const cases: Array<Record<string, unknown>> = [
      { backend: 'mock', referenceIds: ['ref_not_exists'] },
      { backend: 'mock', referenceSectionIds: ['rsec_not_exists'] },
      { backend: 'mock', referenceIds: [otherReference.id] },
      { backend: 'mock', referenceSectionIds: [otherSections[0].id] },
      // 小节必须落在所选引用范围内。
      {
        backend: 'mock',
        referenceIds: [references[0].id],
        referenceSectionIds: [
          (await sectionsOf(baseUrl, ctx.projectId, references[1].id))[0].id,
        ],
      },
    ];
    for (const body of cases) {
      const response = await generate(baseUrl, ctx.documentId, body);
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe('validation_error');
    }
    expect(await runCount(ctx)).toBe(0);
  });

  it('讨论接口同样接受 provider 与引用过滤，并校验归属', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx);
    // 先用 mock 生成提案（离线）。
    const generated = await generate(baseUrl, ctx.documentId, { backend: 'mock', count: 1 });
    expect(generated.status).toBe(202);
    await waitRun(baseUrl, generated.body.run.id);
    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    const proposal = proposals[0];
    const references = await referencesOf(baseUrl, ctx.projectId);

    const ok = await jsonApi<{ run: Run }>(baseUrl, 'POST', `/api/proposals/${proposal.id}/discuss`, {
      message: '请补充引用与边界说明',
      provider: 'mock',
      referenceIds: [references[0].id],
    });
    expect(ok.status).toBe(202);
    expect(ok.body.run.backend).toBe('mock');
    expect(ok.body.run.provider).toBe('mock');
    const run = await waitRun(baseUrl, ok.body.run.id);
    expect(run.status).toBe('succeeded');
    const updated = await api<{ proposal: Proposal }>(baseUrl, `/api/proposals/${proposal.id}`);
    expect(updated.body.proposal.discussionCount).toBe(1);
    expect(updated.body.proposal.status).toBe('revised');

    const invalid = await jsonApi<{ error: { code: string } }>(
      baseUrl,
      'POST',
      `/api/proposals/${proposal.id}/discuss`,
      { message: '继续讨论', provider: 'mock', referenceIds: [otherRefIdFor(ctx)] },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation_error');

    const credential = await jsonApi<{ error: { code: string } }>(
      baseUrl,
      'POST',
      `/api/proposals/${proposal.id}/discuss`,
      { message: '继续讨论', backend: 'dsh', provider: 'openai-compatible' },
    );
    expect(credential.status).toBe(400);
    expect(credential.body.error.code).toBe('credential_missing');
  });
});

function otherRefIdFor(ctx: TestContext): string {
  const row = ctx.db
    .prepare("SELECT id FROM references_docs WHERE project_id = ? LIMIT 1")
    .get(ctx.projectId) as unknown as { id: string };
  // 用真实存在的引用构造“不属于本项目”的 id（去掉前缀后随机化）。
  return `${row.id}_not_exists`;
}

/* ------------------------------------------------------------------ *
 * 真实 provider（注入 fetch 假响应，不访问网络）
 * ------------------------------------------------------------------ */

interface GenerationPayload {
  proposals: Array<{
    paragraphId: string;
    oldText: string;
    newText: string;
    reason: string;
    citations: Array<{ referenceId: string }>;
  }>;
}

function buildGenerationContent(document: Document, referenceId: string): string {
  const target = document.paragraphs.find(
    (block) => block.chapterIndex === 0 && block.type === 'paragraph',
  );
  if (!target) throw new Error('测试文档缺少第一章正文段落');
  const payload: GenerationPayload = {
    proposals: [
      {
        paragraphId: target.id,
        oldText: target.text,
        newText: `${target.text}（引用技术说明补充说明）`,
        reason: '依据技术说明中的检索链路要求补充说明。',
        citations: [{ referenceId }],
      },
    ],
  };
  return JSON.stringify(payload);
}

describe('P1 真实 provider：run/提案记录真实 provider 与 model', () => {
  it('provider=openai-compatible 使用该网关，run 与提案记录真实 provider/model', async () => {
    const ctx = makeConfiguredContext('openai');
    const baseUrl = await serve(ctx);
    const documentResponse = await api<{ document: Document }>(
      baseUrl,
      `/api/documents/${ctx.documentId}`,
    );
    expect(documentResponse.status).toBe(200);
    const references = await referencesOf(baseUrl, ctx.projectId);
    const content = buildGenerationContent(documentResponse.body.document, references[0].id);

    const calls = stubProviderFetch(() =>
      jsonResponse({
        model: 'deepseek-flash',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      }),
    );

    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'dsh',
      provider: 'openai-compatible',
      count: 1,
      prompt: '第一章给出 1 条修改建议；仅出建议',
    });
    expect(response.status).toBe(202);
    expect(response.body.run.backend).toBe('dsh');
    expect(response.body.run.provider).toBe('openai-compatible');
    expect(response.body.run.model).toBe('deepseek-flash');

    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(run.error).toBeNull();
    expect(run.provider).toBe('openai-compatible');
    expect(run.model).toBe('deepseek-flash');
    expect(run.tokensIn).toBe(11);
    expect(run.tokensOut).toBe(22);
    expect(run.events.some((event) => JSON.stringify(event.data ?? {}).includes('openai-compatible'))).toBe(
      true,
    );

    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].provider).toBe('openai-compatible');
    expect(proposals[0].model).toBe('deepseek-flash');
    expect(proposals[0].backend).toBe('dsh');
    expect(proposals[0].citations[0]?.referenceId).toBe(references[0].id);
    expect(proposals[0].citations[0]?.locator.length).toBeGreaterThan(0);

    // 请求确实发往配置的网关，且请求体/头符合契约；响应与运行记录不含密钥。
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GATEWAY_BASE_URL}/chat/completions`);
    const requestBody = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(requestBody.response_format).toEqual({ type: 'json_object' });
    expect(requestBody.model).toBe('deepseek-flash');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toContain(API_KEY);

    expect(JSON.stringify(run)).not.toContain(API_KEY);
    expect(JSON.stringify(proposals)).not.toContain(API_KEY);
  });

  it('provider=deepseek-anthropic 使用官方端点并记录实际 provider/model', async () => {
    const ctx = makeConfiguredContext('anthropic');
    const baseUrl = await serve(ctx);
    const documentResponse = await api<{ document: Document }>(
      baseUrl,
      `/api/documents/${ctx.documentId}`,
    );
    const references = await referencesOf(baseUrl, ctx.projectId);
    const content = buildGenerationContent(documentResponse.body.document, references[0].id);

    const calls = stubProviderFetch(() =>
      jsonResponse({
        model: 'deepseek-flash',
        content: [{ type: 'text', text: content }],
        usage: { input_tokens: 3, output_tokens: 4 },
        stop_reason: 'end_turn',
      }),
    );

    const response = await generate(baseUrl, ctx.documentId, {
      backend: 'dsh',
      provider: 'deepseek-anthropic',
      count: 1,
      prompt: '第一章给出 1 条修改建议；仅出建议',
    });
    expect(response.status).toBe(202);
    expect(response.body.run.provider).toBe('deepseek-anthropic');
    expect(response.body.run.model).toBe('deepseek-flash');

    const run = await waitRun(baseUrl, response.body.run.id);
    expect(run.status).toBe('succeeded');
    expect(run.provider).toBe('deepseek-anthropic');
    expect(run.model).toBe('deepseek-flash');
    expect(run.tokensIn).toBe(3);
    expect(run.tokensOut).toBe(4);

    const proposals = await proposalsOf(baseUrl, ctx.documentId);
    expect(proposals[0].provider).toBe('deepseek-anthropic');
    expect(proposals[0].model).toBe('deepseek-flash');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ANTHROPIC_BASE_URL}/v1/messages`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(JSON.stringify(run)).not.toContain(API_KEY);
  });
});
