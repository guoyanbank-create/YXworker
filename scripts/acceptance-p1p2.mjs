#!/usr/bin/env node
/**
 * P1/P2 验收脚本（API 级）：引用定位/来源、provider 三选与 status、故障与超时、
 * Mermaid 图表与版本绑定、FeatureSpec、ImpactPlan、批量采纳、公文模板导出。
 *
 * 用法：node scripts/acceptance-p1p2.mjs [--base-url http://127.0.0.1:8787]
 * 默认在临时数据目录启动真实服务端（读本机模型凭据，读操作真实网关）。
 * 产出：artifacts/p1p2/{result.json, gov.docx, tech.docx, render-<template>/pages, server.log}
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'p1p2');
mkdirSync(artifactsDir, { recursive: true });

const args = process.argv.slice(2);
const baseUrlArg = args.indexOf('--base-url');
const externalBase = baseUrlArg >= 0 ? args[baseUrlArg + 1] : null;
const port = 8800;
const baseUrl = externalBase ?? `http://127.0.0.1:${port}`;

const results = [];
let failures = 0;
function record(item, ok, detail = '') {
  results.push({ item, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`);
}

async function http(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, contentType };
}
const json = (method, path, payload) =>
  http(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

async function waitRun(runId, timeoutMs = 240_000) {
  const started = Date.now();
  let run = null;
  while (Date.now() - started < timeoutMs) {
    run = (await http(`/api/runs/${runId}`)).body.run;
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await sleep(600);
  }
  throw new Error(`run ${runId} 超时未结束`);
}

let server = null;
let tempDataDir = null;
async function startServer() {
  if (externalBase) {
    record('启动方式', true, `复用外部服务 ${baseUrl}`);
    return;
  }
  if (!existsSync(join(root, 'apps/server/dist/index.js'))) {
    throw new Error('缺少构建产物，请先 pnpm build');
  }
  tempDataDir = mkdtempSync(join(tmpdir(), 'yxworker-p1p2-'));
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
      const res = await http('/api/health');
      if (res.status === 200) {
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
  const projects = (await http('/api/projects')).body.projects;
  const project = projects.find((p) => p.name.includes('智惠导服')) ?? projects[0];
  const projectDetail = (await http(`/api/projects/${project.id}`)).body;
  const documentId = projectDetail.document.id;

  // ---------- P1-1 引用定位 / 来源 ----------
  const refs = (await http(`/api/projects/${project.id}/references`)).body.references;
  record('P1-1 引用含小节数', refs.length >= 2 && refs.every((r) => (r.sectionCount ?? 0) > 0), `refs=${refs.length} sectionCounts=${refs.map((r) => r.sectionCount).join(',')}`);
  const locators = (await http(`/api/projects/${project.id}/references/locators?q=%E8%AF%95%E7%82%B9`)).body.results;
  record(
    'P1-1 @ 检索返回 locator+excerpt',
    locators.length > 0 && locators.every((r) => r.locator && r.excerpt && r.referenceId && r.referenceTitle),
    `results=${locators.length} first=${locators[0]?.locator}`,
  );
  const firstRef = refs[0];
  const sectionsRes = await http(`/api/projects/${project.id}/references/${firstRef.id}/sections`);
  const sections = sectionsRes.body.sections;
  record('P1-1 引用小节列表', sectionsRes.status === 200 && sections.length >= 3, `sections=${sections.length}`);
  const section = sections[0];
  const sectionDetail = await http(`/api/projects/${project.id}/references/${firstRef.id}/sections/${section.id}`);
  record(
    'P1-1 来源打开（单小节）',
    sectionDetail.status === 200 && sectionDetail.body.section?.locator === section.locator && sectionDetail.body.section?.content?.length > 0,
    `locator=${section.locator}`,
  );

  // ---------- P1-3 status / provider 三选 ----------
  const status = (await http('/api/status')).body;
  record(
    'P1-3 status 展示当前 provider 与超时上限',
    Boolean(
      status.current &&
        typeof status.current.modelTimeoutMs === 'number' &&
        typeof status.current.watchdogTimeoutMs === 'number' &&
        status.current.providerId &&
        status.current.backend,
    ),
    `current=${status.current?.providerId}/${status.current?.model} timeout=${status.current?.modelTimeoutMs}ms watchdog=${status.current?.watchdogTimeoutMs}ms`,
  );
  const providerIds = status.providers.map((p) => p.id).sort();
  record(
    'P1-3 三 provider 可选（openai-compatible/deepseek-anthropic/mock）',
    ['deepseek-anthropic', 'mock', 'openai-compatible'].every((id) => providerIds.includes(id)),
    `providers=${providerIds.join(',')}`,
  );

  // mock provider 运行（明确标注）
  const mockGenerated = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '第三章给出 5 条修改建议；仅出建议',
    tier: 'draft',
    backend: 'dsh',
    provider: 'mock',
    count: 2,
  });
  if (mockGenerated.status !== 202) throw new Error(`mock generate 失败: HTTP ${mockGenerated.status} ${JSON.stringify(mockGenerated.body?.error)}`);
  const mockRun = await waitRun(mockGenerated.body.run.id);
  record(
    'P1-3 provider=mock 运行且标注 mock',
    mockRun.status === 'succeeded' && mockRun.provider === 'mock' && mockRun.backend === 'dsh',
    `provider=${mockRun.provider} model=${mockRun.model}`,
  );

  // 真实 provider：openai-compatible（真实网关）
  const realGenerated = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '引用历史方案与技术说明，对第三章提出5条修改建议；仅出建议。',
    tier: 'review',
    backend: 'dsh',
    provider: 'openai-compatible',
    count: 5,
  });
  const realRun = await waitRun(realGenerated.body.run.id);
  const afterReal = (await http(`/api/documents/${documentId}/proposals`)).body.proposals;
  const realProposals = afterReal.filter((p) => p.runId === realRun.id);
  record(
    'P1-3 openai-compatible 真实模型运行（非 Mock）',
    realRun.status === 'succeeded' && realRun.provider === 'openai-compatible' && realRun.model === 'deepseek-flash' && realRun.latencyMs > 0 && realRun.tokensIn > 0 && realProposals.every((p) => p.provider === 'openai-compatible'),
    `status=${realRun.status} provider=${realRun.provider} model=${realRun.model} latency=${realRun.latencyMs}ms tokens=${realRun.tokensIn}/${realRun.tokensOut}`,
  );

  // deepseek-anthropic 真实端点（若官方端点不可用，记录真实错误而不是假成功）
  const anthropicGenerated = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '第三章给出 2 条修改建议；仅出建议',
    tier: 'draft',
    backend: 'dsh',
    provider: 'deepseek-anthropic',
    count: 2,
  });
  if (anthropicGenerated.status !== 202) {
    record(
      'P1-3 deepseek-anthropic provider 可切换',
      false,
      `HTTP ${anthropicGenerated.status} code=${anthropicGenerated.body?.error?.code ?? 'unknown'}（可选 provider：未配置凭据/端点不可达时如实记录，不冒充成功）`,
    );
  } else {
    const anthropicRun = await waitRun(anthropicGenerated.body.run.id);
    record(
      'P1-3 deepseek-anthropic provider 可切换并真实调用',
      anthropicRun.status === 'succeeded' && anthropicRun.provider === 'deepseek-anthropic',
      `status=${anthropicRun.status} provider=${anthropicRun.provider} model=${anthropicRun.model} code=${anthropicRun.error?.code ?? 'null'}`,
    );
  }

  // 指定引用小节注入
  const filteredGen = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '引用指定资料给出 2 条建议',
    tier: 'draft',
    backend: 'dsh',
    provider: 'mock',
    count: 2,
    referenceSectionIds: [section.id],
  });
  const filteredRun = await waitRun(filteredGen.body.run.id);
  record('P1-1 指定 referenceSectionIds 生成', filteredRun.status === 'succeeded', `status=${filteredRun.status}`);

  // ---------- P1-3 故障与超时可见 ----------
  const faultTimeout = await json('POST', `/api/documents/${documentId}/proposals/generate`, {
    prompt: '第三章给出 2 条修改建议',
    tier: 'review',
    backend: 'dsh',
    count: 2,
    fault: 'timeout',
  });
  const timeoutRun = await waitRun(faultTimeout.body.run.id);
  record(
    'P1-3 超时故障可见（model_timeout + latencyMs/retryReason）',
    timeoutRun.status === 'failed' && timeoutRun.error?.code === 'model_timeout' && typeof timeoutRun.latencyMs === 'number',
    `code=${timeoutRun.error?.code} latency=${timeoutRun.latencyMs} retry=${timeoutRun.retryReason}`,
  );

  // ---------- P2-5 Mermaid 图表 + 版本绑定 ----------
  const versions = (await http(`/api/documents/${documentId}/versions`)).body.versions;
  const v10 = versions.find((v) => v.name === 'V1.0');
  const diagramSource = 'flowchart LR\n  A[入口] --> B[检索]\n  B --> C[回答]';
  const createdDiagram = await json('POST', `/api/projects/${project.id}/diagrams`, {
    title: '验收图表',
    kind: 'flowchart',
    source: diagramSource,
    description: 'P1/P2 验收自动创建',
    chapterRef: '第三章 功能拆解与实施路径',
  });
  const diagram = createdDiagram.body.diagram;
  record(
    'P2-5 图表创建并绑定当前 revision',
    createdDiagram.status === 201 && diagram?.documentRevision > 0 && diagram?.source.includes('flowchart'),
    `revision=${diagram?.documentRevision} version=${diagram?.versionName ?? 'current'}`,
  );
  const listDiagrams = (await http(`/api/projects/${project.id}/diagrams`)).body.diagrams;
  record('P2-5 图表列表', listDiagrams.some((d) => d.id === diagram.id), `diagrams=${listDiagrams.length}`);
  const bindRes = await json('POST', `/api/diagrams/${diagram.id}/bind`, { versionId: v10.id });
  record(
    'P2-5 绑定命名版本 V1.0',
    bindRes.status === 200 && bindRes.body.diagram?.versionName === 'V1.0' && bindRes.body.diagram?.documentRevision === v10.revision,
    `version=${bindRes.body.diagram?.versionName} revision=${bindRes.body.diagram?.documentRevision}`,
  );
  const updatedDiagram = await json('PUT', `/api/diagrams/${diagram.id}`, { source: diagramSource + '\n  C --> D[引用]' });
  record('P2-5 图表更新', updatedDiagram.status === 200 && updatedDiagram.body.diagram?.source.includes('引用'), 'source 已更新');

  // ---------- P2-6 FeatureSpec ----------
  const createdFeature = await json('POST', `/api/projects/${project.id}/features`, {
    title: '验收功能条目',
    description: 'P1/P2 验收自动创建',
    status: 'planned',
    priority: 'P1',
    chapterRef: '第三章 功能拆解与实施路径',
  });
  const feature = createdFeature.body.feature;
  const patchedFeature = await json('PATCH', `/api/features/${feature.id}`, { status: 'in_progress' });
  record(
    'P2-6 功能清单创建/更新',
    createdFeature.status === 201 && patchedFeature.status === 200 && patchedFeature.body.feature?.status === 'in_progress',
    `id=${feature.id}`,
  );

  // ---------- P2-7 ImpactPlan ----------
  const pending = (await http(`/api/documents/${documentId}/proposals`)).body.proposals.filter((p) => p.status === 'proposed');
  record('P2-7 存在待审提案用于影响分析', pending.length > 0, `pending=${pending.length}`);
  const planRes = await json('POST', `/api/documents/${documentId}/impact-plan`, {
    proposalIds: pending.slice(0, 3).map((p) => p.id),
    trigger: 'acceptance',
  });
  const plan = planRes.body.plan;
  record(
    'P2-7 ImpactPlan 展示受影响章节/图表/功能',
    planRes.status === 201 &&
      plan?.affected?.chapters?.length > 0 &&
      Array.isArray(plan.affected.diagrams) &&
      plan.affected.diagrams.some((d) => d.diagram?.id === diagram.id || d.diagram?.chapterRef === '第三章 功能拆解与实施路径') &&
      Array.isArray(plan.affected.featureSpecs),
    `chapters=${plan?.affected?.chapters?.length} diagrams=${plan?.affected?.diagrams?.length} features=${plan?.affected?.featureSpecs?.length}`,
  );
  const executeRes = await json('POST', `/api/impact-plans/${plan.id}/execute`, {});
  record(
    'P2-7 ImpactPlan 逐项执行（批量采纳）',
    executeRes.status === 200 &&
      executeRes.body.plan?.executedAt &&
      Array.isArray(executeRes.body.batch?.results) &&
      executeRes.body.batch.results.some((r) => r.ok),
    `results=${executeRes.body.batch?.results?.length} executedAt=${Boolean(executeRes.body.plan?.executedAt)}`,
  );

  // ---------- P2-8 批量采纳（混合状态）----------
  const allProposals = (await http(`/api/documents/${documentId}/proposals`)).body.proposals;
  const acceptedOne = allProposals.find((p) => p.status === 'accepted');
  const rejectedOne = allProposals.find((p) => p.status === 'rejected' || p.status === 'conflicted');
  const pendingForBatch = allProposals.filter((p) => p.status === 'proposed' || p.status === 'revised').slice(0, 3);
  const batchIds = [...pendingForBatch.map((p) => p.id), ...(acceptedOne ? [acceptedOne.id] : [])];
  const batchRes = await json('POST', `/api/documents/${documentId}/proposals/batch-accept`, {
    ids: batchIds,
    reviewer: '验收员',
  });
  record(
    'P2-8 批量采纳逐条结果（成功+失败并存）',
    batchRes.status === 200 &&
      batchRes.body.results?.length === batchIds.length &&
      batchRes.body.results.some((r) => r.ok) &&
      batchRes.body.results.some((r) => !r.ok) &&
      batchRes.body.document?.revision > 0,
    `results=${batchRes.body.results?.map((r) => `${r.id.slice(-4)}:${r.ok ? 'ok' : r.error}`).join(',')}`,
  );

  // ---------- P2-8 模板导出 ----------
  const templates = (await http('/api/templates')).body.templates;
  record(
    'P2-8 两套模板可用（gov/tech）',
    templates.length === 2 && templates.some((t) => t.id === 'gov') && templates.some((t) => t.id === 'tech'),
    `templates=${templates.map((t) => t.id).join(',')}`,
  );
  for (const template of ['gov', 'tech']) {
    const exportRes = await http(`/api/documents/${documentId}/export.docx?template=${template}`);
    const path = join(artifactsDir, `${template}.docx`);
    if (exportRes.status === 200) writeFileSync(path, exportRes.body);
    const isZip = Buffer.isBuffer(exportRes.body) && exportRes.body.subarray(0, 2).toString() === 'PK';
    record(`P2-8 模板导出 ${template}`, exportRes.status === 200 && isZip && exportRes.body.length > 2000, `bytes=${Buffer.isBuffer(exportRes.body) ? exportRes.body.length : 0}`);
    if (isZip) {
      const render = spawnSync(process.execPath, [join(root, 'scripts/verify-docx.mjs'), path, join(artifactsDir, `render-${template}`)], { encoding: 'utf8' });
      let info = null;
      try {
        const start = render.stdout.indexOf('{');
        info = start >= 0 ? JSON.parse(render.stdout.slice(start)) : null;
      } catch {
        info = null;
      }
      record(`P2-8 模板 ${template} 可渲染`, render.status === 0 && info && info.pageFiles.length > 0, info ? `pages=${info.pageFiles.length}` : `exit=${render.status}`);
    }
  }

  writeFileSync(join(artifactsDir, 'result.json'), JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results, failures }, null, 2));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nP1/P2 验收: ${passed}/${results.length} 通过，${failures} 失败（artifacts/p1p2/result.json）`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('P1/P2 验收异常:', error);
  code = 1;
} finally {
  if (server) server.kill('SIGTERM');
  if (tempDataDir) console.log(`临时数据目录: ${tempDataDir}`);
  process.exit(code);
}
