/**
 * 运行记录服务（Run）：创建 / 查询 / 事件流 / 状态流转 / 取消。
 * 生成与讨论都是异步 Run（HTTP 202），前端轮询 GET /api/runs/:id 查看事件。
 * 不写入/打印模型密钥、文档正文或上游响应全文。
 */
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { notFound } from '../errors.js';
import type { Run, RunError, RunEvent, RunStatus, RunType } from '../types.js';

interface RunRow {
  id: string;
  project_id: string;
  document_id: string;
  type: string;
  status: string;
  backend: string;
  provider: string;
  model: string;
  tier: string;
  prompt: string;
  error_json: string | null;
  events_json: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  retry_reason: string | null;
  fallback_from: string | null;
  data_policy_id: string;
  created_at: string;
  updated_at: string;
}

function safeParse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function mapRunRow(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    type: row.type as RunType,
    status: row.status as RunStatus,
    backend: row.backend,
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    prompt: row.prompt,
    error: safeParse<RunError | null>(row.error_json, null),
    events: safeParse<RunEvent[]>(row.events_json, []),
    latencyMs: row.latency_ms,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    retryReason: row.retry_reason,
    fallbackFrom: row.fallback_from,
    dataPolicyId: row.data_policy_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TERMINAL_STATUSES = new Set<RunStatus>(['succeeded', 'failed', 'cancelled']);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function nextEvents(events: RunEvent[]): RunEvent[] {
  return [...events];
}

export interface CreateRunInput {
  projectId: string;
  documentId: string;
  type: RunType;
  backend: string;
  provider: string;
  model: string;
  tier: string;
  prompt: string;
  dataPolicyId?: string;
}

export function createRun(db: Db, input: CreateRunInput): Run {
  const id = newId('run');
  const at = nowIso();
  const events: RunEvent[] = [
    {
      seq: 1,
      at,
      level: 'info',
      message: '已创建运行任务（排队中）',
      data: {
        type: input.type,
        backend: input.backend,
        provider: input.provider,
        model: input.model,
        tier: input.tier,
      },
    },
  ];
  db.prepare(
    `INSERT INTO runs (id, project_id, document_id, type, status, backend, provider, model, tier, prompt,
       error_json, events_json, latency_ms, tokens_in, tokens_out, retry_reason, fallback_from,
       data_policy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, NULL, ?, 0, 0, 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.documentId,
    input.type,
    input.backend,
    input.provider,
    input.model,
    input.tier,
    input.prompt,
    JSON.stringify(events),
    input.dataPolicyId ?? 'default',
    at,
    at,
  );
  return getRun(db, id);
}

export function findRun(db: Db, id: string): Run | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? mapRunRow(row) : null;
}

export function getRun(db: Db, id: string): Run {
  const run = findRun(db, id);
  if (!run) throw notFound('not_found', '运行记录不存在');
  return run;
}

export function listRunsByProject(db: Db, projectId: string, limit = 20): Run[] {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
  const rows = db
    .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(projectId, safeLimit) as unknown as RunRow[];
  return rows.map(mapRunRow);
}

function writeRun(
  db: Db,
  id: string,
  patch: {
    status?: RunStatus;
    error?: RunError | null;
    events?: RunEvent[];
    latencyMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    retryReason?: string | null;
    fallbackFrom?: string | null;
    model?: string;
    provider?: string;
  },
): Run {
  const current = getRun(db, id);
  const events = patch.events ?? current.events;
  db.prepare(
    `UPDATE runs SET status = ?, error_json = ?, events_json = ?, latency_ms = ?, tokens_in = ?, tokens_out = ?,
       retry_reason = ?, fallback_from = ?, model = ?, provider = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    JSON.stringify(patch.error === undefined ? current.error : patch.error),
    JSON.stringify(events),
    patch.latencyMs ?? current.latencyMs,
    patch.tokensIn ?? current.tokensIn,
    patch.tokensOut ?? current.tokensOut,
    patch.retryReason === undefined ? current.retryReason : patch.retryReason,
    patch.fallbackFrom === undefined ? current.fallbackFrom : patch.fallbackFrom,
    patch.model ?? current.model,
    patch.provider ?? current.provider,
    nowIso(),
    id,
  );
  return getRun(db, id);
}

export function appendRunEvent(
  db: Db,
  runId: string,
  event: { level: RunEvent['level']; message: string; data?: unknown },
): Run {
  const run = getRun(db, runId);
  if (isTerminalStatus(run.status)) return run;
  const events = nextEvents(run.events);
  events.push({
    seq: events.length + 1,
    at: nowIso(),
    level: event.level,
    message: event.message,
    data: event.data,
  });
  return writeRun(db, runId, { events });
}

export function markRunRunning(db: Db, runId: string): Run {
  const run = getRun(db, runId);
  if (isTerminalStatus(run.status)) return run;
  const events = nextEvents(run.events);
  events.push({ seq: events.length + 1, at: nowIso(), level: 'info', message: '执行器开始执行' });
  return writeRun(db, runId, { status: 'running', events });
}

export interface FinishRunInput {
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  retryReason?: string | null;
  fallbackFrom?: string | null;
  model?: string;
  provider?: string;
}

export function finishRun(db: Db, runId: string, input: FinishRunInput): Run {
  const run = getRun(db, runId);
  if (run.status === 'cancelled') return run;
  const events = nextEvents(run.events);
  events.push({
    seq: events.length + 1,
    at: nowIso(),
    level: 'info',
    message: '运行完成',
    data: {
      latencyMs: input.latencyMs,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      retryReason: input.retryReason ?? null,
    },
  });
  return writeRun(db, runId, {
    status: 'succeeded',
    error: null,
    events,
    latencyMs: input.latencyMs,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    retryReason: input.retryReason ?? null,
    fallbackFrom: input.fallbackFrom ?? null,
    model: input.model,
    provider: input.provider,
  });
}

export function failRun(
  db: Db,
  runId: string,
  error: RunError,
  options: { latencyMs?: number; retryReason?: string | null } = {},
): Run {
  const run = getRun(db, runId);
  if (run.status === 'cancelled') return run;
  const events = nextEvents(run.events);
  events.push({
    seq: events.length + 1,
    at: nowIso(),
    level: 'error',
    message: `运行失败：${error.code}`,
    data: { code: error.code, retryable: error.retryable },
  });
  return writeRun(db, runId, {
    status: 'failed',
    error,
    events,
    latencyMs: options.latencyMs ?? run.latencyMs,
    retryReason: options.retryReason ?? run.retryReason,
  });
}

export function cancelRun(db: Db, runId: string): Run {
  const run = getRun(db, runId);
  if (isTerminalStatus(run.status)) return run;
  const events = nextEvents(run.events);
  events.push({
    seq: events.length + 1,
    at: nowIso(),
    level: 'warn',
    message: '运行已被取消',
  });
  return writeRun(db, runId, { status: 'cancelled', events });
}

/** 进程内取消信号（真实 fetch 在下一事件边界响应）。 */
const runAborts = new Map<string, AbortController>();

export function registerRunAbort(runId: string): AbortController {
  const controller = new AbortController();
  runAborts.set(runId, controller);
  return controller;
}

export function abortRunExecution(runId: string): boolean {
  const controller = runAborts.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function unregisterRunAbort(runId: string): void {
  runAborts.delete(runId);
}
