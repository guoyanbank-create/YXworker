/** 测试辅助：内存 SQLite + 种子数据 + 临时 HTTP 服务。 */
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { ensureSeed } from '../src/seed/seed.js';

export interface TestContext {
  db: Db;
  app: Express;
  projectId: string;
  documentId: string;
}

export function makeTestContext(options: { seed?: boolean } = {}): TestContext {
  const db = openDb(':memory:');
  const seeded = options.seed === false ? null : ensureSeed(db);
  const testConfig = {
    ...config,
    // 测试永不访问真实模型；凭据置空，避免误用本机凭据。
    llmConfiguredFlag: false,
    llm: { ...config.llm, apiKey: '', baseUrl: '' },
    deepseek: { ...config.deepseek, apiKey: '' },
    faultInjection: true,
    seedDemo: false,
  };
  Object.defineProperty(testConfig, 'llmConfigured', { get: () => false });
  const app = createApp({ db, config: testConfig });
  return {
    db,
    app,
    projectId: seeded?.projectId ?? '',
    documentId: seeded?.documentId ?? '',
  };
}

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(app: Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, reject) => {
            server.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 保留文本（用于二进制/非 JSON 断言）
  }
  return { status: response.status, body: body as T };
}

/** 便捷：发 JSON 请求。 */
export async function jsonApi<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<ApiResult<T>> {
  return api<T>(baseUrl, path, {
    method,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
