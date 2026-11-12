#!/usr/bin/env node
/**
 * 真实模型调用“硬超时 + 错误映射”验证（对应缺陷报告：run 不得停留在 running）。
 *
 * 做法：起一个只接受连接、永不响应的 HTTP 服务模拟“卡死的模型网关”，再起一个指向它、
 * 模型超时设为 3s 的 YXworker 实例；发起真实 provider 生成，断言：
 * - run 在数秒内进入 failed；
 * - error.code=model_timeout；
 * - latencyMs 已写入（不是 0）；retryReason 可见；
 * - 不产生提案，事件链可见。
 *
 * 用法：node scripts/verify-timeout.mjs
 * 产物：artifacts/timeout/{result.json,server.log}
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'timeout');
mkdirSync(artifactsDir, { recursive: true });

const hangPort = 18793;
const appPort = 18794;
const modelTimeoutMs = 3000;
const results = [];
let failures = 0;
function record(item, ok, detail = '') {
  results.push({ item, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`);
}

if (!existsSync(join(root, 'apps/server/dist/index.js'))) {
  console.error('缺少构建产物，请先 pnpm build');
  process.exit(2);
}

const hangServer = http.createServer((_req, _res) => {
  // 故意永不响应：模拟网关连接成功但请求悬挂
});
await new Promise((resolve) => hangServer.listen(hangPort, '127.0.0.1', resolve));
console.log(`[verify-timeout] 悬挂网关监听 127.0.0.1:${hangPort}`);

const dataDir = mkdtempSync(join(tmpdir(), 'yxworker-timeout-'));
const log = createWriteStream(join(artifactsDir, 'server.log'));
const app = spawn(process.execPath, [join(root, 'apps/server/dist/index.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    HOST: '127.0.0.1',
    YXWORKER_DATA_DIR: dataDir,
    YXWORKER_LLM_BASE_URL: `http://127.0.0.1:${hangPort}/v1`,
    YXWORKER_LLM_API_KEY: 'timeout-verification-dummy-key',
    YXWORKER_LLM_TIMEOUT_MS: String(modelTimeoutMs),
    YXWORKER_NO_SEED: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.pipe(log);
app.stderr.pipe(log);

const baseUrl = `http://127.0.0.1:${appPort}`;
async function waitHealth() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      // wait
    }
    await sleep(200);
  }
  return false;
}

let exitCode = 1;
try {
  const healthy = await waitHealth();
  record('服务启动', healthy, `http://127.0.0.1:${appPort}`);
  if (!healthy) throw new Error('服务未就绪');

  const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
  const project = projects.projects[0];
  const created = await (
    await fetch(`${baseUrl}/api/documents/${project.documentId}/proposals/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '引用历史方案与技术说明，对第三章提出5条修改建议；仅出建议。',
        tier: 'review',
        backend: 'dsh',
        count: 5,
      }),
    })
  ).json();
  const runId = created.run.id;
  const started = Date.now();
  let run = created.run;
  while (Date.now() - started < 30_000) {
    run = (await (await fetch(`${baseUrl}/api/runs/${runId}`)).json()).run;
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) break;
    await sleep(300);
  }
  const elapsed = Date.now() - started;
  record(
    '悬挂请求被硬超时终止（不会停留在 running）',
    run.status === 'failed' && elapsed < modelTimeoutMs + 10_000,
    `elapsed=${elapsed}ms status=${run.status}`,
  );
  record('错误码映射 model_timeout', run.error?.code === 'model_timeout', `code=${run.error?.code}`);
  record('latencyMs 已写入（非 0）', run.latencyMs > 0, `latencyMs=${run.latencyMs}`);
  record('retryReason 可见', typeof run.retryReason === 'string' && run.retryReason.length > 0, `retryReason=${run.retryReason}`);
  record(
    '事件链完整（含失败事件）',
    Array.isArray(run.events) && run.events.some((event) => event.message.includes('model_timeout')),
    `events=${run.events?.length}`,
  );
  const proposals = await (await fetch(`${baseUrl}/api/documents/${project.documentId}/proposals`)).json();
  record('超时失败不产生提案', proposals.proposals.length === 0, `proposals=${proposals.proposals.length}`);

  writeFileSync(
    join(artifactsDir, 'result.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results, failures, run }, null, 2),
  );
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n硬超时验证: ${passed}/${results.length} 通过，${failures} 失败（artifacts/timeout/result.json）`);
  exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error('验证异常:', error);
} finally {
  app.kill('SIGTERM');
  hangServer.close();
  process.exit(exitCode);
}
