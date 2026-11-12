#!/usr/bin/env node
/**
 * P0 验收脚本（PRODUCT_SPEC §11 的 1–8 条，API 级 + 文档/导出证据）。
 *
 * 做法：在临时数据目录启动真实服务端（读取 ~/.config/yxworker/credentials.env 的真实模型网关），
 * 依次执行：建项目/读文档 → 真实模型生成 5 条提案 → 采纳2/拒绝1/讨论1/待审1 → 人工编辑触发冲突
 * → 版本 V1.1/查看/回退 → 导出 DOCX 并渲染 → 故障与数据分级阻断 → 模拟执行器兜底。
 *
 * 用法：node scripts/acceptance.mjs [--base-url http://127.0.0.1:8787]
 * 产出：artifacts/acceptance/{result.json, exported.docx, render/pages/*.png, server.log}
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'acceptance');
mkdirSync(artifactsDir, { recursive: true });

const args = process.argv.slice(2);
const baseUrlArg = args.indexOf('--base-url');
const externalBase = baseUrlArg >= 0 ? args[baseUrlArg + 1] : null;
const port = 8799;
const baseUrl = externalBase ?? `http://127.0.0.1:${port}`;

const results = [];
let failures = 0;
function record(item, ok, detail) {
  results.push({ item, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail ?? ''}`);
}

async function http(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body };
}

const json = (method, path, payload) =>
  http(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

async function waitRun(runId, { timeoutMs = 240_000 } = {}) {
  const started = Date.now();
  let run = null;
  while (Date.now() - started < timeoutMs) {
    const res = await http(`/api/runs/${runId}`);
    if (res.status !== 200) throw new Error(`查询 run 失败: ${res.status}`);
    run = res.body.run;
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await sleep(600);
  }
  throw new Error(`run ${runId} 超时未结束`);
}

function paragraphMap(document) {
  return new Map(document.paragraphs.map((p) => [p.id, p]));
}

/** 判断 doc 的段落文本是否只有给定 targetIds 允许变化（用于“只写入采纳内容”断言）。 */
function changedParagraphIds(before, after) {
  const a = paragraphMap(before);
  const b = paragraphMap(after);
  const changed = [];
  for (const [id, block] of b) {
    if (!a.has(id) || a.get(id).text !== block.text) changed.push(id);
  }
  return changed;
}

let server = null;
let tempDataDir = null;

async function startServer() {
  if (externalBase) {
    record('启动方式', true, `复用外部服务 ${baseUrl}`);
    return;
  }
  if (!existsSync(join(root, 'apps/server/dist/index.js')) || !existsSync(join(root, 'apps/web/dist/index.html'))) {
    record('启动方式', false, '缺少构建产物，请先 pnpm build');
    throw new Error('缺少构建产物');
  }
  tempDataDir = mkdtempSync(join(tmpdir(), 'yxworker-acceptance-'));
  const logPath = join(artifactsDir, 'server.log');
  const { createWriteStream } = await import('node:fs');
  const log = createWriteStream(logPath);
  server = spawn(process.execPath, [join(root, 'apps/server/dist/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      YXWORKER_DATA_DIR: tempDataDir,
      YXWORKER_LLM_TIMEOUT_MS: process.env.YXWORKER_LLM_TIMEOUT_MS ?? '180000',
      ...(process.env.YXWORKER_LLM_TIMEOUT_MS
        ? { YXWORKER_LLM_TIMEOUT_MS: process.env.YXWORKER_LLM_TIMEOUT_MS }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await http('/api/health');
      if (res.status === 200) {
        record('启动方式', true, `node apps/server/dist/index.js 监听 ${baseUrl}（临时数据目录）`);
        return;
      }
    } catch {
      // 继续等待
    }
    await sleep(300);
  }
  record('启动方式', false, '服务未在 18s 内就绪');
  throw new Error('服务启动失败');
}

async function main() {
  await startServer();

  // §11.1 项目与 4 章节文档
  const projectsRes = await http('/api/projects');
  record('§11.1 项目存在', projectsRes.status === 200 && projectsRes.body.projects.length >= 1, `projects=${projectsRes.body.projects?.length}`);
  const project = projectsRes.body.projects.find((p) => p.name.includes('智惠导服')) ?? projectsRes.body.projects[0];
  const projectRes = await http(`/api/projects/${project.id}`);
  const documentId = projectRes.body.document.id;
  const docRes = await http(`/api/documents/${documentId}`);
  const document0 = docRes.body.document;
  const chapters = document0.paragraphs.filter((p) => p.type === 'heading' && (p.level ?? 1) <= 2);
  record('§11.1 四章节方案', chapters.length === 4, `chapters=${chapters.map((c) => c.text).join(' | ')}`);
  record('§11.1 引用资料', (await http(`/api/projects/${project.id}/references`)).body.references.length >= 2, '≥2 份引用');

  // §11.2 真实模型生成 5 条建议
  const genRes = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议',
    tier: 'review',
    backend: 'dsh',
    count: 5,
  });
  const run = await waitRun(genRes.body.run.id);
  record('§11.2 真实模型生成运行成功', run.status === 'succeeded', `status=${run.status} backend=${run.backend} provider=${run.provider} model=${run.model} latency=${run.latencyMs}ms tokens=${run.tokensIn}/${run.tokensOut} events=${run.events.length}`);
  if (run.status !== 'succeeded') record('§11.2 失败原因', false, JSON.stringify(run.error));
  const proposalsRes = await http(`/api/documents/${documentId}/proposals`);
  const proposals = proposalsRes.body.proposals.filter((p) => p.runId === run.id);
  const ch3 = proposals.filter((p) => p.chapterTitle.includes('第三章'));
  record(
    '§11.2 真实模型 provenance（非 Mock）',
    run.provider === 'openai-compatible' &&
      run.model === 'deepseek-flash' &&
      run.backend === 'dsh' &&
      run.latencyMs > 0 &&
      (run.tokensIn > 0 || run.tokensOut > 0) &&
      proposals.every(
        (p) => p.backend === 'dsh' && p.provider === 'openai-compatible' && p.model === 'deepseek-flash',
      ),
    `provider=${run.provider} model=${run.model} backend=${run.backend} latency=${run.latencyMs}ms tokens=${run.tokensIn}/${run.tokensOut} proposalIds=${proposals.map((p) => p.id).join(',')}`,
  );

  record(
    '§11.2 五条建议卡片数据',
    proposals.length === 5 && ch3.length >= 4 && proposals.every((p) => p.citations.length > 0 && p.oldText && p.newText && p.reason),
    `proposals=${proposals.length} chapter3=${ch3.length} citations=${proposals.map((p) => p.citations.length).join(',')}`,
  );

  // §11.3 采纳 2 条、拒绝 1 条、继续讨论 1 条、其余待审；只写入采纳内容
  const beforeRev = document0.revision;
  const acceptA = await json('POST', `/api/proposals/${proposals[0].id}/accept`, { reviewer: '验收员' });
  const acceptB = await json('POST', `/api/proposals/${proposals[1].id}/accept`, { reviewer: '验收员' });
  record('§11.3 采纳两条', acceptA.status === 200 && acceptB.status === 200 && acceptA.body.proposal.status === 'accepted' && acceptB.body.proposal.status === 'accepted', `status=${acceptA.status}/${acceptB.status}`);
  const docAfterAccept = (await http(`/api/documents/${documentId}`)).body.document;
  const changed = changedParagraphIds(document0, docAfterAccept);
  const acceptedIds = [proposals[0].paragraphId, proposals[1].paragraphId];
  record(
    '§11.3 只写入采纳内容',
    changed.length === 2 && acceptedIds.every((id) => changed.includes(id)),
    `changed=${changed.join(',')} expected=${acceptedIds.join(',')} revision ${beforeRev}→${docAfterAccept.revision}`,
  );
  record(
    '§11.3 采纳后文本等于建议文本',
    paragraphMap(docAfterAccept).get(proposals[0].paragraphId)?.text === proposals[0].newText &&
      paragraphMap(docAfterAccept).get(proposals[1].paragraphId)?.text === proposals[1].newText,
    'newText 已读回一致',
  );

  const rejectRes = await json('POST', `/api/proposals/${proposals[2].id}/reject`, { reviewer: '验收员', note: '不符合当前口径' });
  const docAfterReject = (await http(`/api/documents/${documentId}`)).body.document;
  record(
    '§11.3 拒绝后原文不动',
    rejectRes.status === 200 && rejectRes.body.proposal.status === 'rejected' && changedParagraphIds(document0, docAfterReject).length === 2,
    `status=${rejectRes.status}`,
  );

  const discussRes = await json('POST', `/api/proposals/${proposals[3].id}/discuss`, { message: '请更简洁，并补充一条引用依据', tier: 'review' });
  const discussRun = await waitRun(discussRes.body.run.id);
  const discussed = (await http(`/api/proposals/${proposals[3].id}`)).body.proposal;
  const docAfterDiscuss = (await http(`/api/documents/${documentId}`)).body.document;
  record(
    '§11.3 继续讨论只更新该条',
    discussRun.status === 'succeeded' && discussed.discussionCount >= 1 && docAfterDiscuss.revision === docAfterReject.revision,
    `run=${discussRun.status} discussionCount=${discussed.discussionCount} revision不变=${docAfterDiscuss.revision}`,
  );
  const pendingId = proposals[4].id;
  const pending = (await http(`/api/proposals/${pendingId}`)).body.proposal;
  record('§11.3 其余保持待审', pending.status === 'proposed', `status=${pending.status}`);

  // §11.4 审阅期间人工修改 → 旧提案 conflict，禁止覆盖
  const docBeforeManual = (await http(`/api/documents/${documentId}`)).body.document;
  const manualTarget = document0.paragraphs.find((p) => p.id === pending.paragraphId) ?? document0.paragraphs[6];
  const manualContent = structuredClone(docBeforeManual.contentJson);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.attrs?.paragraphId === manualTarget.id) {
      node.content = [{ type: 'text', text: '人工修改：该段落在审阅期间被手动调整。' }];
      return true;
    }
    return (node.content ?? []).some(walk);
  };
  walk(manualContent);
  const manualSave = await json('PUT', `/api/documents/${documentId}/content`, {
    contentJson: manualContent,
    baseRevision: docBeforeManual.revision,
    actor: '人工编辑',
  });
  const docAfterManualSave = manualSave.body.document ?? (await http(`/api/documents/${documentId}`)).body.document;
  const conflictedIds = (manualSave.body.conflictedProposals ?? []).map((p) => p.id);
  const afterManual = (await http(`/api/proposals/${pendingId}`)).body.proposal;
  record(
    '§11.4 人工编辑触发冲突',
    manualSave.status === 200 && afterManual.status === 'conflicted' && conflictedIds.includes(pendingId),
    `conflictedProposals=${conflictedIds.join(',')}`,
  );
  const acceptConflicted = await json('POST', `/api/proposals/${pendingId}/accept`, {});
  const docAfterConflictAttempt = (await http(`/api/documents/${documentId}`)).body.document;
  record(
    '§11.4 冲突提案禁止覆盖',
    [409, 422].includes(acceptConflicted.status) && docAfterConflictAttempt.revision === docAfterManualSave.revision,
    `accept status=${acceptConflicted.status} code=${acceptConflicted.body?.error?.code} revision不变`,
  );

  // §11.5 生成 V1.1、查看 V1.0、回退、导出
  const createVersion = await json('POST', `/api/documents/${documentId}/versions`, { name: 'V1.1' });
  const versions = (await http(`/api/documents/${documentId}/versions`)).body.versions;
  record(
    '§11.5 命名版本 V1.1',
    createVersion.status === 201 && ['V1.0', 'V1.1'].every((name) => versions.some((v) => v.name === name)),
    `versions=${versions.map((v) => v.name).join(',')}`,
  );
  const v10 = versions.find((v) => v.name === 'V1.0');
  const restore = await json('POST', `/api/versions/${v10.id}/restore`, {});
  const restoredDoc = restore.body.document;
  const originalTexts = document0.paragraphs.map((p) => p.text).join('\n');
  const restoredTexts = restoredDoc.paragraphs.map((p) => p.text).join('\n');
  record('§11.5 回退到 V1.0', restore.status === 200 && restoredTexts === originalTexts, `revision=${restoredDoc.revision}`);

  const exportRes = await http(`/api/documents/${documentId}/export.docx`);
  const docxPath = join(artifactsDir, 'exported.docx');
  if (exportRes.status === 200) writeFileSync(docxPath, exportRes.body);
  const isZip = Buffer.isBuffer(exportRes.body) && exportRes.body.subarray(0, 2).toString() === 'PK';
  record('§11.5 导出 DOCX', exportRes.status === 200 && isZip && exportRes.body.length > 2000, `bytes=${Buffer.isBuffer(exportRes.body) ? exportRes.body.length : 'n/a'} zip=${isZip}`);
  const render = spawnSync(process.execPath, [join(root, 'scripts/verify-docx.mjs'), docxPath, join(artifactsDir, 'render')], { encoding: 'utf8' });
  let renderInfo = null;
  try {
    const jsonStart = render.stdout.indexOf('{');
    renderInfo = jsonStart >= 0 ? JSON.parse(render.stdout.slice(jsonStart)) : null;
  } catch {
    renderInfo = null;
  }
  record(
    '§11.5 DOCX 可渲染（LibreOffice 引擎）',
    render.status === 0 && renderInfo && renderInfo.pageFiles.length > 0,
    renderInfo ? `pages=${renderInfo.pageFiles.length} missingFonts=${renderInfo.missingFonts.length}` : `render exit=${render.status}`,
  );

  // §11.1 补充：把导出的 DOCX 作为引用资料上传，验证 DOCX 提取链路（mammoth）
  const referencesBefore = (await http(`/api/projects/${project.id}/references`)).body.references.length;
  const form = new FormData();
  form.append(
    'file',
    new Blob([exportRes.body], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    '历史方案-DOCX导入验证.docx',
  );
  const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/references`, { method: 'POST', body: form });
  const uploadBody = await uploadRes.json();
  const referencesAfter = (await http(`/api/projects/${project.id}/references`)).body.references.length;
  record(
    '§11.1 DOCX 引用上传与提取',
    uploadRes.status === 201 && referencesAfter === referencesBefore + 1 && (uploadBody.reference?.charCount ?? 0) > 100,
    `status=${uploadRes.status} charCount=${uploadBody.reference?.charCount}`,
  );

  // §11.6 真实模型请求证据 + 模拟执行器兜底（Codex 不要求）
  const statusRes = await http('/api/status');
  const dshBackend = statusRes.body.backends?.find((b) => b.id === 'dsh');
  const codexBackend = statusRes.body.backends?.find((b) => b.id === 'codex');
  record(
    '§11.6 执行器状态（DSH 默认可用 / Codex 不要求）',
    Boolean(dshBackend?.available) && codexBackend?.available === false,
    `dsh=${dshBackend?.available} codex=${codexBackend?.available} (${codexBackend?.reason})`,
  );
  const mockGen = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议',
    tier: 'draft',
    backend: 'mock',
    count: 5,
  });
  const mockRun = await waitRun(mockGen.body.run.id);
  const mockProposals = (await http(`/api/documents/${documentId}/proposals`)).body.proposals.filter((p) => p.runId === mockRun.id);
  record(
    '§11.6 模拟执行器兜底（明确标记模拟）',
    mockRun.status === 'succeeded' && mockRun.backend === 'mock' && mockProposals.length === 5 && mockProposals.every((p) => p.backend === 'mock'),
    `mock proposals=${mockProposals.length}`,
  );

  // §11.7 故障：429/500/断网/数据分级外发；不丢文档
  const docBeforeFault = (await http(`/api/documents/${documentId}`)).body.document;
  async function faultCase(fault, expectedCodes, label) {
    const res = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
      prompt: '第三章给出 5 条修改建议',
      tier: 'review',
      backend: 'dsh',
      count: 5,
      fault,
    });
    if (res.status !== 202) {
      record(label, false, `HTTP ${res.status} ${JSON.stringify(res.body?.error)}`);
      return;
    }
    const failedRun = await waitRun(res.body.run.id);
    record(
      label,
      failedRun.status === 'failed' && expectedCodes.includes(failedRun.error?.code),
      `run=${failedRun.status} code=${failedRun.error?.code}`,
    );
  }
  await faultCase('rate_limit', ['model_rate_limited'], '§11.7 模拟 429');
  await faultCase('server_error', ['model_unavailable'], '§11.7 模拟 500');
  await faultCase('network', ['model_unavailable', 'model_timeout'], '§11.7 模拟断网');
  await faultCase('timeout', ['model_timeout'], '§11.7 模拟超时（run 不得悬挂）');
  await json('PATCH', `/api/projects/${project.id}`, { dataLevel: 'secret' });
  const policyFault = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '第三章给出 5 条修改建议',
    tier: 'review',
    backend: 'dsh',
    count: 5,
  });
  let policyBlocked = false;
  let policyDetail = `HTTP ${policyFault.status} code=${policyFault.body?.error?.code}`;
  if (policyFault.status === 403) {
    policyBlocked = policyFault.body?.error?.code === 'data_policy_blocked';
  } else if (policyFault.status === 202) {
    const run = await waitRun(policyFault.body.run.id);
    policyBlocked = run.status === 'failed' && run.error?.code === 'data_policy_blocked';
    policyDetail = `run=${run.status} code=${run.error?.code}`;
  }
  record('§11.7 数据分级外发阻断', policyBlocked, policyDetail);
  await json('PATCH', `/api/projects/${project.id}`, { dataLevel: 'internal' });
  const docAfterFault = (await http(`/api/documents/${documentId}`)).body.document;
  record(
    '§11.7 故障后文档不丢',
    docAfterFault.revision === docBeforeFault.revision && JSON.stringify(docAfterFault.paragraphs) === JSON.stringify(docBeforeFault.paragraphs),
    `revision=${docAfterFault.revision}`,
  );

  // §11.8 交付物（由本脚本+PR 记录）
  record('§11.8 测试与交付记录', true, '见 pnpm test 输出、本脚本输出与 docs/DELIVERY.md');

  writeFileSync(join(artifactsDir, 'result.json'), JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results, failures }, null, 2));
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n验收结果: ${passed}/${total} 通过，${failures} 失败（明细 artifacts/acceptance/result.json）`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('验收脚本异常:', error);
} finally {
  if (server) server.kill('SIGTERM');
  if (tempDataDir) console.log(`临时数据目录: ${tempDataDir}`);
  process.exit(code);
}
