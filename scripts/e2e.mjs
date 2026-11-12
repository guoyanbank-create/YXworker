#!/usr/bin/env node
/**
 * 本机 UI 端到端验收（Playwright + 系统 Chrome）。
 *
 * 默认自行启动一个临时数据目录的真实服务端（读取本机模型凭据），走完：
 * 载入工作台 → 真实模型生成 5 条建议 → 采纳 2/拒绝 1/继续讨论 1 → 人工编辑触发冲突
 * → 创建命名版本 → 导出 Word → 故障演练（429）→ 截图留证。
 *
 * 用法：node scripts/e2e.mjs [--base-url http://127.0.0.1:8787] [--headless=false]
 * 产出：artifacts/e2e/{result.json, *.png, exported.docx, server.log}
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'e2e');
mkdirSync(artifactsDir, { recursive: true });

const args = process.argv.slice(2);
const baseUrlArg = args.indexOf('--base-url');
const externalBase = baseUrlArg >= 0 ? args[baseUrlArg + 1] : null;
const headless = !args.includes('--headless=false');
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = Number(process.env.E2E_PORT ?? 8788);
const baseUrl = externalBase ?? `http://127.0.0.1:${port}`;

const results = [];
let failures = 0;
function record(item, ok, detail = '') {
  results.push({ item, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`);
}

function loadPlaywright() {
  const require = createRequire(join(root, 'package.json'));
  const candidates = ['playwright-core', '/tmp/univer-spike/node_modules/playwright-core'];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // 尝试下一个
    }
  }
  throw new Error('未找到 playwright-core。请先在仓库根执行 `pnpm install`。');
}

let server = null;
let tempDataDir = null;
async function startServer() {
  if (externalBase) {
    record('启动方式', true, `复用外部服务 ${baseUrl}`);
    return;
  }
  if (!existsSync(join(root, 'apps/server/dist/index.js')) || !existsSync(join(root, 'apps/web/dist/index.html'))) {
    throw new Error('缺少构建产物，请先 pnpm build');
  }
  tempDataDir = mkdtempSync(join(tmpdir(), 'yxworker-e2e-'));
  const log = createWriteStream(join(artifactsDir, 'server.log'));
  server = spawn(process.execPath, [join(root, 'apps/server/dist/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      YXWORKER_DATA_DIR: tempDataDir,
      YXWORKER_LLM_TIMEOUT_MS: process.env.YXWORKER_LLM_TIMEOUT_MS ?? '180000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        record('启动方式', true, `node apps/server/dist/index.js @ ${baseUrl}`);
        return;
      }
    } catch {
      // 等待
    }
    await sleep(250);
  }
  throw new Error('服务未在 20s 内就绪');
}

async function main() {
  await startServer();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromePath, headless });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 400)));

  const shot = async (name) => {
    const path = join(artifactsDir, `${name}.png`);
    await page.screenshot({ path });
    return path;
  };
  const cards = () => page.locator('[data-testid="proposal-card"]');
  const card = (i) => cards().nth(i);
  const statusOf = async (i) =>
    (await card(i).locator('[data-testid="proposal-status"]').innerText()).trim();
  const waitStatus = async (i, expected, timeout = 120_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const text = await statusOf(i).catch(() => '');
      if (text.includes(expected)) return text;
      await sleep(500);
    }
    return statusOf(i).catch(() => '');
  };
  const step = (message) => console.log(`STEP  ${message}`);

  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="editor"]', { timeout: 30_000 });
    await page.waitForTimeout(800);
    const projectName = await page.locator('[data-testid="topbar-project-name"]').innerText();
    record('工作台载入', projectName.includes('智惠导服'), `project=${projectName.trim()}`);
    await shot('00-workbench');

    // 真实模型生成 5 条建议
    await page.click('[data-testid="btn-fill-example"]');
    await page.fill('[data-testid="prompt-input"]', '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议');
    await page.selectOption('[data-testid="tier-select"]', 'review');
    await page.selectOption('[data-testid="backend-select"]', 'dsh');
    await page.click('[data-testid="btn-generate"]');
    step('已点击生成，等待建议卡片');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="proposal-card"]').length >= 5,
      null,
      { timeout: 240_000 },
    );
    await page.waitForTimeout(1200);
    const initialCount = await cards().count();
    const initialStatuses = [];
    for (let i = 0; i < initialCount; i += 1) initialStatuses.push(await statusOf(i));
    record(
      '真实模型生成建议卡片',
      initialCount >= 5 && initialStatuses.every((s) => s.includes('待审')),
      `cards=${initialCount}`,
    );
    // provenance 断言：本次生成必须来自真实 DSH 网关（不是 Mock），且 Run 有耗时/token
    const projects = await (await page.request.get(`${baseUrl}/api/projects`)).json();
    const project = projects.projects[0];
    const proposalsBody = await (
      await page.request.get(`${baseUrl}/api/documents/${project.documentId}/proposals`)
    ).json();
    const newest = proposalsBody.proposals.slice(-5);
    record(
      '真实模型 provenance（非 Mock）',
      newest.length === 5 &&
        newest.every(
          (p) => p.backend === 'dsh' && p.provider === 'openai-compatible' && p.model === 'deepseek-flash',
        ),
      `model=${newest[0]?.model} backend=${newest[0]?.backend} provider=${newest[0]?.provider}`,
    );
    const runsBody = await (
      await page.request.get(`${baseUrl}/api/projects/${project.id}/runs?limit=5`)
    ).json();
    const latestRun = runsBody.runs.find((r) => r.type === 'proposal_generation' && r.status === 'succeeded');
    record(
      'Run 记录 latency/tokens（完成后已更新）',
      Boolean(latestRun && latestRun.latencyMs > 0 && latestRun.tokensIn > 0),
      `latency=${latestRun?.latencyMs}ms tokens=${latestRun?.tokensIn}/${latestRun?.tokensOut}`,
    );

    const citations = await page.locator('[data-testid="proposal-citation"]').count();
    record('建议卡片带引用依据', citations >= 5, `citations=${citations}`);
    await shot('01-proposals');

    // 采纳 2 条
    for (let i = 0; i < 2; i += 1) {
      await card(i).locator('[data-testid="btn-accept"]').click();
      await page.waitForTimeout(1500);
      const status = await waitStatus(i, '已采纳', 20_000);
      record(`采纳第 ${i + 1} 条`, status.includes('已采纳'), `status=${status}`);
    }
    await page.waitForTimeout(800);
    await shot('02-accepted');

    // 拒绝 1 条 + 继续讨论 1 条（从剩余待审卡片中找）
    const total = await cards().count();
    let rejected = false;
    let discussed = false;
    for (let i = 0; i < total; i += 1) {
      const status = await statusOf(i).catch(() => '');
      if (!status.includes('待审')) continue;
      if (!rejected) {
        await card(i).locator('[data-testid="btn-reject"]').click();
        await page.waitForTimeout(1200);
        const after = await waitStatus(i, '已拒绝', 20_000);
        record('拒绝一条', after.includes('已拒绝'), `status=${after}`);
        rejected = true;
      } else if (!discussed) {
        await card(i).locator('[data-testid="btn-discuss"]').click();
        await card(i).locator('[data-testid="discuss-input"]').fill('请更简洁，并补充一条引用依据');
        await card(i).locator('[data-testid="btn-discuss-send"]').click();
        const after = await waitStatus(i, '修订中', 180_000);
        record('继续讨论只更新该条', after.includes('修订中'), `status=${after}`);
        discussed = true;
      }
      if (rejected && discussed) break;
    }
    record('拒绝与讨论均执行', rejected && discussed, `rejected=${rejected} discussed=${discussed}`);
    await shot('03-reject-discuss');

    // 人工修改待审目标段落 → 冲突
    let pendingIndex = -1;
    const total2 = await cards().count();
    for (let i = 0; i < total2; i += 1) {
      const status = await statusOf(i).catch(() => '');
      if (status.includes('待审')) {
        pendingIndex = i;
        break;
      }
    }
    if (pendingIndex >= 0) {
      await card(pendingIndex).locator('[data-testid="btn-locate"]').click();
      await page.waitForTimeout(600);
      // “定位”已 focus 编辑器并把光标放到目标段落，直接输入即可（不要再点正文/跳到文末）。
      await page.keyboard.type('（人工补充说明，用于验证冲突。）');
      await page.waitForTimeout(2500);
    }
    const conflictVisible = (await page.locator('[data-testid="proposal-conflict"]').count()) > 0;
    record('人工编辑触发冲突且禁止覆盖', conflictVisible, `conflictCards=${await page.locator('[data-testid="proposal-conflict"]').count()}`);
    await shot('04-conflict');

    // 版本：创建 V1.1
    await page.click('[data-testid="btn-versions"]');
    await page.waitForSelector('[data-testid="version-dialog"]');
    await page.fill('[data-testid="version-name-input"]', 'V1.1');
    await page.click('[data-testid="btn-create-version"]');
    await page.waitForTimeout(1500);
    const versionList = await page.locator('[data-testid="version-item"]').allInnerTexts();
    record('创建命名版本 V1.1', versionList.some((t) => t.includes('V1.1')), `versions=${versionList.length}`);
    await shot('05-versions');
    await page.click('[data-testid="btn-version-close"]');

    // 导出 Word
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
    await page.click('[data-testid="btn-export"]');
    const download = await downloadPromise;
    let exportPath = null;
    if (download) {
      exportPath = join(artifactsDir, 'exported.docx');
      await download.saveAs(exportPath);
    }
    record(
      '导出 Word 下载',
      Boolean(exportPath && existsSync(exportPath) && statSync(exportPath).size > 2000),
      exportPath ? `bytes=${statSync(exportPath).size}` : '未捕获下载事件',
    );

    // 故障演练：429
    await page.click('[data-testid="fault-rate-limit"]');
    await page.waitForSelector('[data-testid="fault-result"]', { timeout: 120_000 });
    await page.waitForTimeout(500);
    const faultText = await page.locator('[data-testid="fault-result"]').getAttribute('data-code');
    record('故障演练 429 分流', faultText === 'model_rate_limited', `code=${faultText}`);
    await shot('06-fault');

    const saveStatus = await page.locator('[data-testid="save-status"]').innerText().catch(() => '');
    record('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
    record('保存状态正常', saveStatus.includes('已保存'), `saveStatus=${saveStatus.trim()}`);
    await shot('07-final');
  } finally {
    await browser.close();
  }

  writeFileSync(
    join(artifactsDir, 'result.json'),
    JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results, failures }, null, 2),
  );
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nUI E2E: ${passed}/${results.length} 通过，${failures} 失败（artifacts/e2e/result.json）`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('E2E 异常:', error);
  code = 1;
} finally {
  if (server) server.kill('SIGTERM');
  if (tempDataDir) console.log(`临时数据目录: ${tempDataDir}`);
  process.exit(code);
}
