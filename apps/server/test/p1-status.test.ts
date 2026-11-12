/**
 * P1-3 状态接口测试：/api/status 的 current（backend/providerId/providerLabel/providerKind/model/
 * 超时上限/realModelConfigured）与 providers[].current 标记；超时数值必须与真实调用/看门狗一致。
 * 不访问真实网络。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { ensureSeed, ensureSeedExtras } from '../src/seed/seed.js';
import * as runService from '../src/services/runService.js';
import type { StatusResponse } from '../src/types.js';
import { api, makeTestContext, startTestServer, type TestServer } from './helpers.js';

const API_KEY = 'sk-test-SECRET-DO-NOT-LEAK';

interface CustomContext {
  db: Db;
  app: Express;
  projectId: string;
  documentId: string;
}

/** 带“真实 provider 凭据”的测试上下文（假值，仅用于状态展示；fetch 不会被调用）。 */
function makeRealConfiguredContext(): CustomContext {
  const db = openDb(':memory:');
  const seeded = ensureSeed(db);
  ensureSeedExtras(db);
  const testConfig = {
    ...config,
    llm: {
      ...config.llm,
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: API_KEY,
      model: 'deepseek-flash',
      modelPro: 'deepseek-v4-pro',
      tiers: { draft: 'deepseek-flash', review: 'deepseek-flash', long_reasoning: 'deepseek-v4-pro' },
    },
    deepseek: { ...config.deepseek, apiKey: '' },
    faultInjection: true,
    seedDemo: false,
  };
  Object.defineProperty(testConfig, 'llmConfigured', { get: () => true });
  const app = createApp({ db, config: testConfig });
  return { db, app, projectId: seeded.projectId, documentId: seeded.documentId };
}

const servers: TestServer[] = [];
const dbs: Db[] = [];

async function serve(app: Express, db: Db): Promise<string> {
  const server = await startTestServer(app);
  servers.push(server);
  dbs.push(db);
  return server.baseUrl;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const db of dbs.splice(0)) db.close();
});

describe('P1 /api/status.current（离线默认：回退 mock）', () => {
  it('无真实凭据时 current 指向可用的 mock 链路，且超时与看门狗实现一致', async () => {
    const ctx = makeTestContext();
    const baseUrl = await serve(ctx.app, ctx.db);

    const result = await api<StatusResponse>(baseUrl, '/api/status');
    expect(result.status).toBe(200);
    const current = result.body.current;
    expect(current).toBeTruthy();
    if (!current) throw new Error('缺少 StatusResponse.current');

    expect(current.backend).toBe('mock');
    expect(current.providerId).toBe('mock');
    expect(current.providerKind).toBe('mock');
    expect(current.providerLabel).toContain('模拟');
    expect(current.model).toBe('mock-proposal-v1');
    expect(current.realModelConfigured).toBe(false);

    // 超时数值与 runService 看门狗/模型超时完全一致（默认 60s / 90s）。
    const watchdog = runService.runWatchdogTimeoutMs();
    expect(current.watchdogTimeoutMs).toBe(watchdog);
    expect(current.modelTimeoutMs).toBe(watchdog - 30_000);
    expect(current.modelTimeoutMs).toBe(60_000);
    expect(current.watchdogTimeoutMs).toBe(90_000);

    // providers[].current：恰好一个，且与 current.providerId 一致（可作请求默认值）。
    const flagged = result.body.providers.filter((provider) => provider.current === true);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].id).toBe(current.providerId);
    expect(flagged[0].configured).toBe(true);
    // 状态接口不泄漏凭据/完整 URL。
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
  });

  it('YXWORKER_LLM_TIMEOUT_MS 覆盖时 current 同步变化（模型超时/看门狗）', async () => {
    const previous = process.env.YXWORKER_LLM_TIMEOUT_MS;
    process.env.YXWORKER_LLM_TIMEOUT_MS = '5000';
    try {
      const ctx = makeTestContext();
      const url = await serve(ctx.app, ctx.db);
      const result = await api<StatusResponse>(url, '/api/status');
      const current = result.body.current;
      expect(current?.modelTimeoutMs).toBe(5_000);
      expect(current?.watchdogTimeoutMs).toBe(35_000);
      expect(result.body.limits.modelTimeout).toContain('5000ms');
    } finally {
      if (previous === undefined) delete process.env.YXWORKER_LLM_TIMEOUT_MS;
      else process.env.YXWORKER_LLM_TIMEOUT_MS = previous;
    }
  });
});

describe('P1 /api/status.current（已配置真实 provider）', () => {
  it('真实凭据已配置时 current 指向 openai-compatible + 当前模型', async () => {
    const ctx = makeRealConfiguredContext();
    const baseUrl = await serve(ctx.app, ctx.db);

    const result = await api<StatusResponse>(baseUrl, '/api/status');
    expect(result.status).toBe(200);
    const current = result.body.current;
    expect(current).toBeTruthy();
    if (!current) throw new Error('缺少 StatusResponse.current');

    expect(current.backend).toBe('dsh');
    expect(current.providerId).toBe('openai-compatible');
    expect(current.providerKind).toBe('openai-compatible');
    expect(current.providerLabel.length).toBeGreaterThan(0);
    expect(current.model).toBe('deepseek-flash');
    expect(current.realModelConfigured).toBe(true);
    expect(current.watchdogTimeoutMs).toBe(90_000);
    expect(current.modelTimeoutMs).toBe(60_000);

    const flagged = result.body.providers.filter((provider) => provider.current === true);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].id).toBe('openai-compatible');
    expect(flagged[0].configured).toBe(true);
    // 安全：不返回完整 baseUrl/密钥（仅 host 可省略）。
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('https://gateway.example.com/v1');
  });
});
