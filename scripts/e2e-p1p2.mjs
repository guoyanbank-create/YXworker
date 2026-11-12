#!/usr/bin/env node
/**
 * P1/P2 UI 端到端验收（Playwright + 系统 Chrome）。
 *
 * 覆盖：@引用定位/小节检索/提及、来源弹窗、定位高亮、provider 三选与 status.current、
 * Mock 标注、Mermaid 图表创建/渲染/版本绑定、功能清单、ImpactPlan 构建/执行、批量采纳、
 * 导出模板、超时故障演练。真实模型使用 openai-compatible（真实网关，非 Mock）。
 *
 * 用法：node scripts/e2e-p1p2.mjs [--base-url http://127.0.0.1:8787] [--headless=false]
 * 产出：artifacts/e2e-p1p2/{result.json, *.png, exported-gov.docx, server.log}
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'e2e-p1p2');
mkdirSync(artifactsDir, { recursive: true });

const args = process.argv.slice(2);
const baseUrlArg = args.indexOf('--base-url');
const externalBase = baseUrlArg >= 0 ? args[baseUrlArg + 1] : null;
const headless = !args.includes('--headless=false');
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = Number(process.env.E2E_P12_PORT ?? 8789);
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
  for (const candidate of ['playwright-core', '/tmp/univer-spike/node_modules/playwright-core']) {
    try {
      return require(candidate);
    } catch {
      // next
    }
  }
  throw new Error('未找到 playwright-core，请先 pnpm install');
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
  tempDataDir = mkdtempSync(join(tmpdir(), 'yxworker-e2e-p12-'));
  const log = createWriteStream(join(artifactsDir, 'server.log'));
  server = spawn(process.execPath, [join(root, 'apps/server/dist/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      YXWORKER_DATA_DIR: tempDataDir,
      // 验收环境放宽模型超时以容忍网关抖动；交付默认仍是 60s（可用 YXWORKER_LLM_TIMEOUT_MS 覆盖）
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
      // wait
    }
    await sleep(250);
  }
  throw new Error('服务未就绪');
}

async function main() {
  await startServer();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromePath, headless });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(30_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 400)));

  const shot = async (name) => page.screenshot({ path: join(artifactsDir, `${name}.png`) });
  const cards = () => page.locator('[data-testid="proposal-card"]');
  const statusOf = async (i) => (await cards().nth(i).locator('[data-testid="proposal-status"]').innerText()).trim();
  const waitStatus = async (i, expected, timeout = 180_000) => {
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
    await shot('00-main');

    // ---------- status.current / provider ----------
    const statusRes = await (await page.request.get(`${baseUrl}/api/status`)).json();
    const current = statusRes.current;
    const expectedModelTimeout = Number(
      process.env.YXWORKER_LLM_TIMEOUT_MS ?? (externalBase ? 60000 : 180000),
    );
    record(
      'P1-3 status.current 展示 provider/model/超时',
      Boolean(
        current &&
          current.providerId === 'openai-compatible' &&
          current.model === 'deepseek-flash' &&
          current.modelTimeoutMs === expectedModelTimeout &&
          current.watchdogTimeoutMs === expectedModelTimeout + 30000,
      ),
      `provider=${current?.providerId} model=${current?.model} timeout=${current?.modelTimeoutMs}/${current?.watchdogTimeoutMs}（测试环境覆盖=${process.env.YXWORKER_LLM_TIMEOUT_MS ?? '默认 60000'}）`,
    );
    const providerLabel = await page.locator('[data-testid="provider-current-label"]').innerText().catch(() => '');
    record('P1-3 顶部展示当前 provider', providerLabel.includes('deepseek-flash'), providerLabel.trim());
    await page.selectOption('[data-testid="provider-select"]', 'openai-compatible');
    await page.selectOption('[data-testid="backend-select"]', 'dsh');
    await shot('01-status-provider');

    // ---------- P1-1 @ 引用定位 / 检索 / 提及 ----------
    await page.locator('[data-testid="reference-item"]').first().locator('[data-testid="btn-expand-sections"]').click();
    await page.waitForSelector('[data-testid="ref-section-item"]', { timeout: 15_000 });
    const sectionCount = await page.locator('[data-testid="ref-section-item"]').count();
    await page.fill('[data-testid="ref-locator-search"]', '试点');
    await page.waitForTimeout(800);
    const searchResults = await page.locator('[data-testid="ref-search-result"]').count();
    record('P1-1 引用小节展开与 locator 检索', sectionCount > 0 && searchResults > 0, `sections=${sectionCount} searchResults=${searchResults}`);
    await page.locator('[data-testid="ref-search-result"]').first().click();
    await page.waitForTimeout(500);
    const mentionChips = await page.locator('[data-testid="mention-chip"]').count();
    record('P1-1 小节提及插入', mentionChips > 0, `chips=${mentionChips}`);
    await shot('02-reference-locator');

    // ---------- 真实模型生成 ----------
    await page.fill('[data-testid="prompt-input"]', '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议');
    await page.selectOption('[data-testid="tier-select"]', 'review');
    await page.click('[data-testid="btn-generate"]');
    step('真实模型生成中…');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="proposal-card"]').length >= 5, null, { timeout: 240_000 });
    await page.waitForTimeout(1200);
    const cardCount = await cards().count();
    const projects = await (await page.request.get(`${baseUrl}/api/projects`)).json();
    const project = projects.projects[0];
    const proposals = (await (await page.request.get(`${baseUrl}/api/documents/${project.documentId}/proposals`)).json()).proposals;
    const newest = proposals.slice(-5);
    record(
      'P1 真实模型生成 5 条提案（provenance 非 Mock）',
      cardCount >= 5 && newest.every((p) => p.provider === 'openai-compatible' && p.model === 'deepseek-flash'),
      `cards=${cardCount} model=${newest[0]?.model} provider=${newest[0]?.provider}`,
    );
    await shot('03-real-proposals');

    // ---------- P1-2 来源弹窗 / 定位高亮 ----------
    await page.locator('[data-testid="citation-open"]').first().click();
    await page.waitForSelector('[data-testid="source-dialog"]', { timeout: 15_000 });
    const sourceLocator = await page.locator('[data-testid="source-locator"]').innerText().catch(() => '');
    const sourceContent = await page.locator('[data-testid="source-content"]').innerText().catch(() => '');
    const highlight = await page.locator('[data-testid="source-highlight"]').count();
    record('P1-2 引用来源弹窗（locator/正文/摘录高亮）', sourceLocator.length > 0 && sourceContent.length > 20 && highlight > 0, `locator=${sourceLocator.trim()} content=${sourceContent.length}ch highlight=${highlight}`);
    await shot('04-source-dialog');
    step('关闭来源弹窗');
    await page.click('[data-testid="btn-source-close"]');
    await page.waitForTimeout(300);
    step('点击卡片定位');

    const locateNotes = [];
    await cards().nth(0).locator('[data-testid="btn-locate"]').click();
    await page.waitForTimeout(600);
    const highlightCount = await page.locator('[data-testid="proposal-highlight"]').count();
    locateNotes.push(
      (await page.locator('[data-testid="proposal-locate-note"]').count()) > 0
        ? await page.locator('[data-testid="proposal-locate-note"]').first().innerText().catch(() => '')
        : '',
    );
    record('P1-2 卡片定位到正文并高亮范围', highlightCount > 0, `highlights=${highlightCount}`);
    await shot('05-locate-highlight');

    step('Mock 标注检查');
    // ---------- P1-3 Mock 明确标注 ----------
    await page.selectOption('[data-testid="backend-select"]', 'mock');
    await page.waitForTimeout(600);
    const mockBadge = await page.locator('[data-testid="mock-badge"]').count();
    const providerDisabled = await page.locator('[data-testid="provider-select"]').isDisabled();
    record('P1-3 模拟执行器明确标注且 provider 锁定', mockBadge > 0 && providerDisabled, `mockBadge=${mockBadge} providerLocked=${providerDisabled}`);
    await page.selectOption('[data-testid="backend-select"]', 'dsh');
    await shot('06-mock-labelled');

    // ---------- P2-5 Mermaid 图表 ----------
    await page.click('[data-testid="center-tab-diagrams"]');
    await page.waitForSelector('[data-testid="diagram-panel"]', { timeout: 15_000 });
    await page.click('[data-testid="btn-new-diagram"]');
    await page.fill('[data-testid="diagram-title"]', 'E2E 验收图表');
    await page.fill('[data-testid="diagram-source"]', 'flowchart LR\n  A[输入] --> B[检索]\n  B --> C[回答]');
    await page.click('[data-testid="btn-save-diagram"]');
    await page.waitForTimeout(1500);
    const diagramItems = await page.locator('[data-testid="diagram-item"]').count();
    const previewSvg = await page.locator('[data-testid="mermaid-preview"] svg').count();
    const bindings = await page.locator('[data-testid="diagram-binding"]').allInnerTexts();
    record('P2-5 图表创建/渲染/版本绑定', diagramItems >= 3 && previewSvg > 0 && bindings.some((b) => b.includes('V1.0')), `diagrams=${diagramItems} svg=${previewSvg} bindings=${bindings.map((b) => b.trim()).join('|')}`);
    await shot('07-diagrams');
    // 显式绑定命名版本：编辑第一张图表 → 选择 V1.0 → 绑定
    await page.locator('[data-testid="btn-edit-diagram"]').first().click();
    await page.waitForTimeout(500);
    const versionValue = await page
      .locator('[data-testid="diagram-version-select"] option', { hasText: 'V1.0' })
      .first()
      .getAttribute('value');
    if (versionValue) {
      await page.selectOption('[data-testid="diagram-version-select"]', versionValue);
      await page.waitForTimeout(300);
      await page.click('[data-testid="btn-bind-diagram"]');
      await page.waitForTimeout(1200);
    }
    const boundTexts = await page.locator('[data-testid="diagram-binding"]').allInnerTexts();
    record('P2-5 UI 绑定命名版本', boundTexts.some((t) => t.includes('V1.0')), `bindings=${boundTexts.map((t) => t.trim()).join('|')}`);
    await shot('08-diagram-bind');

    // ---------- P2-6 功能清单 ----------
    await page.click('[data-testid="center-tab-features"]');
    await page.waitForSelector('[data-testid="feature-panel"]', { timeout: 15_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="feature-item"]').length >= 4,
      null,
      { timeout: 20_000 },
    );
    const featureBefore = await page.locator('[data-testid="feature-item"]').count();
    await page.click('[data-testid="btn-add-feature"]');
    await page.fill('[data-testid="feature-new-title-input"]', 'E2E 验收功能');
    await page.fill('[data-testid="feature-new-description-input"]', 'P1/P2 UI E2E 自动创建');
    await page.click('[data-testid="btn-save-feature"]');
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="feature-item"]').length === expected,
      featureBefore + 1,
      { timeout: 20_000 },
    ).catch(() => null);
    const featureAfter = await page.locator('[data-testid="feature-item"]').count();
    record('P2-6 功能清单新增', featureAfter === featureBefore + 1, `${featureBefore}→${featureAfter}`);
    await shot('09-features');

    // ---------- P2-8 批量采纳（先于 Impact 执行，保证有待审提案可批量采纳）----------
    await page.click('[data-testid="center-tab-document"]');
    await page.waitForTimeout(500);
    const selectable = await page.locator('[data-testid="batch-select"]').count();
    if (selectable > 0) {
      // 复选框可能位于 label 内，用原生 click 避免二次激活
      await page.locator('[data-testid="batch-select"]').first().evaluate((el) => el.click());
      await page.waitForTimeout(300);
      const selectedBoxes = await page.locator('[data-testid="batch-select"]:checked').count();
      await page.click('[data-testid="btn-batch-accept"]');
      await page.waitForSelector('[data-testid="batch-results"], [data-testid="batch-results-summary"]', { timeout: 90_000 });
      const batchItems = await page.locator('[data-testid="batch-result-item"]').count();
      record('P2-8 批量采纳逐条结果', selectedBoxes > 0 && batchItems > 0, `checked=${selectedBoxes} results=${batchItems}`);
    } else {
      record('P2-8 批量采纳逐条结果', false, '当前无待审提案可批量采纳');
    }
    await shot('12-batch-accept');

    // ---------- P2-7 ImpactPlan ----------
    await page.click('[data-testid="center-tab-impact"]');
    await page.waitForSelector('[data-testid="impact-panel"]', { timeout: 15_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="impact-select-item"]').length >= 1,
      null,
      { timeout: 20_000 },
    );
    // 复选框在 <label> 内，直接 .check() 可能被 label 二次激活导致状态不变；用“全选”按钮一次性选择。
    await page.locator('[data-testid="impact-panel"] button', { hasText: '全选' }).first().click();
    await page.waitForTimeout(400);
    const selectedCount = await page.locator('[data-testid="impact-select-item"]:checked').count();
    record('P2-7 影响分析可勾选待审提案', selectedCount >= 1, `selected=${selectedCount}`);
    await page.click('[data-testid="btn-build-impact"]');
    // impact-plan 容器始终存在（空态）；等真实结果项出现再断言
    await page
      .waitForSelector('[data-testid="impact-chapter"]', { timeout: 20_000 })
      .catch(() => null);
    await page.waitForTimeout(300);
    const chapterHits = await page.locator('[data-testid="impact-chapter"]').count();
    const diagramHits = await page.locator('[data-testid="impact-diagram"]').count();
    const featureHits = await page.locator('[data-testid="impact-feature"]').count();
    record('P2-7 ImpactPlan 展示受影响章节/图表/功能', chapterHits > 0 && diagramHits > 0 && featureHits > 0, `chapters=${chapterHits} diagrams=${diagramHits} features=${featureHits}`);
    await shot('10-impact-plan');
    await page.click('[data-testid="btn-execute-impact"]');
    await page.waitForSelector('[data-testid="impact-executed"], [data-testid="impact-batch-results"]', { timeout: 60_000 });
    const executedItems = await page.locator('[data-testid="impact-result-item"]').count();
    record('P2-7 ImpactPlan 逐项执行', executedItems > 0, `resultItems=${executedItems}`);
    await shot('11-impact-executed');

    // ---------- P2-8 模板导出 ----------
    await page.selectOption('[data-testid="template-select"]', 'gov');
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
    await page.click('[data-testid="btn-export"]');
    const download = await downloadPromise;
    let exportPath = null;
    if (download) {
      exportPath = join(artifactsDir, 'exported-gov.docx');
      await download.saveAs(exportPath);
    }
    record(
      'P2-8 政务公文模板导出',
      Boolean(exportPath && existsSync(exportPath) && statSync(exportPath).size > 3000),
      exportPath ? `bytes=${statSync(exportPath).size}` : '未捕获下载',
    );

    // ---------- P1-3 超时故障演练 ----------
    await page.click('[data-testid="fault-timeout"]');
    await page.waitForSelector('[data-testid="fault-result"]', { timeout: 120_000 });
    await page.waitForTimeout(500);
    const faultCode = await page.locator('[data-testid="fault-result"]').getAttribute('data-code');
    record('P1-3 超时故障演练可见', faultCode === 'model_timeout', `code=${faultCode}`);
    await shot('13-fault-timeout');

    record('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
    await shot('14-final');
  } finally {
    await browser.close();
  }

  writeFileSync(join(artifactsDir, 'result.json'), JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results, failures }, null, 2));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nP1/P2 UI E2E: ${passed}/${results.length} 通过，${failures} 失败（artifacts/e2e-p1p2/result.json）`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('P1/P2 UI E2E 异常:', error);
} finally {
  if (server) server.kill('SIGTERM');
  if (tempDataDir) console.log(`临时数据目录: ${tempDataDir}`);
  process.exit(code);
}
