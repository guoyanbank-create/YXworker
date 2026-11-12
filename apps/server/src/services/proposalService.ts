/**
 * 提案服务：AI 提案的生成（异步 Run）、讨论（异步 Run）、采纳/拒绝状态机、
 * hash 冲突检测与安全重基、服务端权威写入 + 读回校验、事务与事件审计。
 *
 * 约定：
 * - 多写操作（文档 + 提案 + 事件）由调用方/本服务用 `transaction(db, fn)` 包裹；
 *   本文件中的 markConflictedProposalsForContentChange / listProposals 保持同步导出，
 *   documents 路由直接调用。
 * - 密钥/上游响应正文/文档全文不写入日志或数据库（Run 只记录 code/耗时/token）。
 */
import type { AppConfig, TierName } from '../config.js';
import { newId, nowIso, transaction } from '../db.js';
import type { Db } from '../db.js';
import {
  applyParagraphText,
  hashText,
  validateSingleParagraphChange,
} from '../domain/paragraphs.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { chapterIndexFromPrompt } from '../llm/schema.js';
import { MOCK_MODEL, MOCK_TARGET_CHAPTER_INDEX } from '../llm/mockProvider.js';
import { toRunError, LlmError } from '../llm/types.js';
import type {
  DiscussionOutput,
  NormalizedProposalDraft,
  ProposalDiscussionRequest,
  ProposalGenerationRequest,
  ReferenceMaterial,
} from '../llm/types.js';
import { parseLocators } from '../llm/reference.js';
import { createRuntimeRegistry } from '../runtime/registry.js';
import type {
  DiscussionTask,
  ExecutionResult,
  ExecutionTask,
} from '../runtime/types.js';
import type {
  Citation,
  DataLevel,
  Document,
  ParagraphBlock,
  Proposal,
  ProposalEvent,
  ProposalStatus,
  Run,
  RunType,
} from '../types.js';
import { getDocument, replaceDocumentContent } from './documentsService.js';
import * as runService from './runService.js';

/* ------------------------------------------------------------------ *
 * 行映射
 * ------------------------------------------------------------------ */

interface ProposalRow {
  id: string;
  document_id: string;
  run_id: string | null;
  status: string;
  paragraph_id: string;
  paragraph_index: number;
  chapter_title: string;
  quote: string;
  old_text: string;
  new_text: string;
  reason: string;
  citations_json: string;
  model: string;
  provider: string;
  backend: string;
  tier: string;
  base_revision: number;
  base_hash: string;
  discussion_count: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  reviewer: string | null;
  conflict_reason: string | null;
}

function parseCitations(text: string): Citation[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as Citation[]) : [];
  } catch {
    return [];
  }
}

function mapProposalRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    documentId: row.document_id,
    runId: row.run_id,
    status: row.status as ProposalStatus,
    paragraphId: row.paragraph_id,
    paragraphIndex: row.paragraph_index,
    chapterTitle: row.chapter_title,
    quote: row.quote,
    oldText: row.old_text,
    newText: row.new_text,
    reason: row.reason,
    citations: parseCitations(row.citations_json),
    model: row.model,
    provider: row.provider,
    backend: row.backend,
    tier: row.tier,
    baseRevision: row.base_revision,
    baseHash: row.base_hash,
    discussionCount: row.discussion_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    reviewer: row.reviewer,
    conflictReason: row.conflict_reason,
  };
}

function getProposalRow(db: Db, id: string): ProposalRow {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as unknown as
    | ProposalRow
    | undefined;
  if (!row) throw notFound('not_found', `提案不存在: ${id}`);
  return row;
}

export function findProposal(db: Db, id: string): Proposal | null {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as unknown as
    | ProposalRow
    | undefined;
  return row ? mapProposalRow(row) : null;
}

export function getProposal(db: Db, id: string): Proposal {
  return mapProposalRow(getProposalRow(db, id));
}

/** 文档提案列表（按创建时间升序；UI 右侧卡片顺序）。 */
export function listProposals(db: Db, documentId: string): Proposal[] {
  const rows = db
    .prepare(
      'SELECT * FROM proposals WHERE document_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(documentId) as unknown as ProposalRow[];
  return rows.map(mapProposalRow);
}

/* ------------------------------------------------------------------ *
 * 事件审计
 * ------------------------------------------------------------------ */

function appendProposalEvent(
  db: Db,
  proposalId: string,
  fromStatus: ProposalStatus | null,
  toStatus: ProposalStatus,
  actor: string,
  note: string,
): void {
  db.prepare(
    `INSERT INTO proposal_events (id, proposal_id, from_status, to_status, actor, note, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('pev'), proposalId, fromStatus, toStatus, actor, note.slice(0, 2000), nowIso());
}

/** 读取提案事件（测试/审计用；P0 不单独提供 HTTP 接口）。 */
export function listProposalEvents(db: Db, proposalId: string): ProposalEvent[] {
  const rows = db
    .prepare('SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY at ASC, rowid ASC')
    .all(proposalId) as unknown as Array<{
    id: string;
    proposal_id: string;
    from_status: string | null;
    to_status: string;
    actor: string;
    note: string;
    at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    proposalId: row.proposal_id,
    fromStatus: (row.from_status as ProposalStatus | null) ?? null,
    toStatus: row.to_status as ProposalStatus,
    actor: row.actor,
    note: row.note,
    at: row.at,
  }));
}

/* ------------------------------------------------------------------ *
 * 项目 / 引用（只读）
 * ------------------------------------------------------------------ */

export interface ProjectBrief {
  id: string;
  name: string;
  description: string;
  dataLevel: DataLevel;
  documentId: string;
}

export function getProjectBrief(db: Db, projectId: string): ProjectBrief | null {
  const row = db
    .prepare(
      'SELECT id, name, description, data_level, document_id FROM projects WHERE id = ?',
    )
    .get(projectId) as
    | {
        id: string;
        name: string;
        description: string;
        data_level: string;
        document_id: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    dataLevel: row.data_level as DataLevel,
    documentId: row.document_id,
  };
}

/** 项目引用材料（含正文，仅在服务端内存中使用；不返回给前端）。 */
export function referencesForProject(db: Db, projectId: string): ReferenceMaterial[] {
  const rows = db
    .prepare(
      'SELECT id, title, content_text FROM references_docs WHERE project_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(projectId) as unknown as Array<{
    id: string;
    title: string;
    content_text: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content_text,
    locators: parseLocators(row.content_text),
  }));
}

/* ------------------------------------------------------------------ *
 * 生成结果落库
 * ------------------------------------------------------------------ */

export interface CreateProposalsInput {
  documentId: string;
  runId: string | null;
  /** 生成开始时的文档 revision（写入 baseRevision）。 */
  baseRevision: number;
  drafts: NormalizedProposalDraft[];
  model: string;
  provider: string;
  backend: string;
  tier: string;
  actor?: string;
}

/**
 * 把校验后的提案写入数据库（status=proposed），并写初始 proposal_event。
 * 注意：本函数不 BEGIN/COMMIT，调用方需包在 transaction 中。
 */
export function createProposalsFromDrafts(db: Db, input: CreateProposalsInput): Proposal[] {
  const at = nowIso();
  const created: Proposal[] = [];
  for (const draft of input.drafts) {
    const id = newId('prop');
    db.prepare(
      `INSERT INTO proposals (id, document_id, run_id, status, paragraph_id, paragraph_index, chapter_title,
         quote, old_text, new_text, reason, citations_json, model, provider, backend, tier,
         base_revision, base_hash, discussion_count, created_at, updated_at, decided_at, reviewer, conflict_reason)
       VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL)`,
    ).run(
      id,
      input.documentId,
      input.runId,
      draft.paragraphId,
      draft.paragraphIndex,
      draft.chapterTitle,
      draft.quote,
      draft.oldText,
      draft.newText,
      draft.reason,
      JSON.stringify(draft.citations),
      input.model,
      input.provider,
      input.backend,
      input.tier,
      input.baseRevision,
      // baseHash 是生成时目标段落原文的 hash（用于采纳时的冲突检测/安全重基）。
      hashText(draft.oldText),
      at,
      at,
    );
    appendProposalEvent(
      db,
      id,
      null,
      'proposed',
      input.actor ?? 'ai',
      `AI 生成建议（run=${input.runId ?? 'n/a'}，backend=${input.backend}，model=${input.model}）`,
    );
    created.push(getProposal(db, id));
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * 冲突标记（documents 路由在 PUT 内容后调用；保持同步）
 * ------------------------------------------------------------------ */

/**
 * 文档内容变化后，把目标段落文本 hash 已变化的 proposed/revised 提案标记为 conflicted，
 * 记录 conflictReason 与 proposal_event，并返回本次被标记的提案。
 * 语义（供 documents 路由使用）：只改其它段落时，不受影响的提案保持 proposed。
 */
export function markConflictedProposalsForContentChange(
  db: Db,
  documentId: string,
  oldBlocks: ParagraphBlock[],
  newBlocks: ParagraphBlock[],
): Proposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM proposals WHERE document_id = ? AND status IN ('proposed','revised') ORDER BY created_at ASC, rowid ASC`,
    )
    .all(documentId) as unknown as ProposalRow[];
  const oldHashes = new Map(oldBlocks.map((block) => [block.id, block.hash]));
  const newHashes = new Map(newBlocks.map((block) => [block.id, block.hash]));
  const marked: Proposal[] = [];
  const at = nowIso();
  for (const row of rows) {
    const beforeHash = oldHashes.get(row.paragraph_id);
    const afterHash = newHashes.get(row.paragraph_id);
    if (afterHash !== undefined && beforeHash === afterHash) continue;
    const reason =
      afterHash === undefined
        ? `目标段落 ${row.paragraph_id} 已不存在（文档结构变化），提案冲突`
        : `目标段落 ${row.paragraph_id} 的原文在审阅期间已变化（hash 不一致），禁止覆盖`;
    db.prepare(
      `UPDATE proposals SET status = 'conflicted', conflict_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(reason, at, row.id);
    appendProposalEvent(
      db,
      row.id,
      row.status as ProposalStatus,
      'conflicted',
      'system',
      reason,
    );
    marked.push(getProposal(db, row.id));
  }
  return marked;
}

function markSingleProposalConflicted(
  db: Db,
  proposal: Proposal,
  reason: string,
  actor = 'system',
): Proposal {
  db.prepare(
    `UPDATE proposals SET status = 'conflicted', conflict_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(reason, nowIso(), proposal.id);
  appendProposalEvent(db, proposal.id, proposal.status, 'conflicted', actor, reason);
  return getProposal(db, proposal.id);
}

/* ------------------------------------------------------------------ *
 * 状态机：采纳 / 拒绝
 * ------------------------------------------------------------------ */

const ACTIONABLE_STATUSES: readonly ProposalStatus[] = ['proposed', 'revised'];

function assertActionable(proposal: Proposal, action: string): void {
  if (!ACTIONABLE_STATUSES.includes(proposal.status)) {
    throw conflict(
      'proposal_state_invalid',
      `提案当前状态为 ${proposal.status}，不允许${action}`,
      { proposal },
    );
  }
}

export interface AcceptProposalInput {
  reviewer?: string;
}

export interface AcceptProposalResult {
  proposal: Proposal;
  document: Document;
}

/**
 * 服务端权威采纳（API_CONTRACT §4）：
 * 1) 仅 proposed/revised 可采纳；
 * 2) 目标段落当前 hash 与 baseHash 不一致 → 标 conflicted + 409 proposal_conflicted；
 * 3) 仅全局 revision 变化、目标段落 hash 未变 → 安全重基后继续；
 * 4) 写入 → 读回校验（只允许目标段落文本变化且等于 newText），失败回滚 422；
 * 5) 事务提交（文档 + 提案 + 事件），其余受影响提案标记冲突。
 */
export function acceptProposal(
  db: Db,
  proposalId: string,
  input: AcceptProposalInput = {},
): AcceptProposalResult {
  const proposal = getProposal(db, proposalId);
  assertActionable(proposal, '采纳');

  const before = getDocument(db, proposal.documentId);
  const target = before.paragraphs.find((block) => block.id === proposal.paragraphId);
  if (!target || target.hash !== proposal.baseHash) {
    const reason = !target
      ? `目标段落 ${proposal.paragraphId} 已不存在（文档结构变化），提案冲突`
      : `目标段落原文在审阅期间已变化（hash 不一致），禁止覆盖`;
    const conflicted = transaction(db, () =>
      markSingleProposalConflicted(db, proposal, reason, input.reviewer?.trim() || 'system'),
    );
    throw conflict('proposal_conflicted', '目标段落已变化，提案已标记冲突，禁止覆盖', {
      proposal: conflicted,
    });
  }

  const reviewer = input.reviewer?.trim() || 'reviewer';
  const rebaseFrom = proposal.baseRevision;
  const rebased = before.revision !== proposal.baseRevision;

  return transaction(db, () => {
    // 事务内重新读取，确保写入的是当前正文（本进程内单写者，无并发写交错）。
    const doc = getDocument(db, proposal.documentId);
    const currentTarget = doc.paragraphs.find((block) => block.id === proposal.paragraphId);
    if (!currentTarget || currentTarget.hash !== proposal.baseHash) {
      // 理论上不会发生；保守起见不写入并提示（不在此处标记，避免回滚事件）。
      throw conflict('proposal_conflicted', '目标段落已变化，禁止覆盖', {
        proposal: getProposal(db, proposal.id),
      });
    }

    const applied = applyParagraphText(doc.contentJson, proposal.paragraphId, proposal.newText);
    if (!applied.applied) {
      throw conflict('proposal_conflicted', '目标段落不存在，禁止覆盖', {
        proposal: getProposal(db, proposal.id),
      });
    }
    const newDocument = replaceDocumentContent(db, proposal.documentId, applied.contentJson, {
      actor: reviewer,
      reason: `accept proposal ${proposal.id}`,
    });

    // 服务端权威读回校验：只允许目标段落变化且等于 newText，否则整体回滚。
    const validation = validateSingleParagraphChange(
      doc.paragraphs,
      newDocument.paragraphs,
      proposal.paragraphId,
      proposal.newText,
    );
    if (!validation.ok) {
      throw unprocessable('apply_validation_failed', `采纳后读回校验失败：${validation.reason}`, {
        reason: validation.reason,
      });
    }
    const targetAfter = newDocument.paragraphs.find(
      (block) => block.id === proposal.paragraphId,
    );

    const at = nowIso();
    db.prepare(
      `UPDATE proposals SET status = 'accepted', base_revision = ?, base_hash = ?, decided_at = ?,
         reviewer = ?, conflict_reason = NULL, updated_at = ? WHERE id = ?`,
    ).run(newDocument.revision, targetAfter?.hash ?? proposal.baseHash, at, reviewer, at, proposal.id);
    appendProposalEvent(
      db,
      proposal.id,
      proposal.status,
      'accepted',
      reviewer,
      `采纳并写入文档 revision ${newDocument.revision}${
        rebased ? `（安全重基：提案 baseRevision ${rebaseFrom} → 当前 ${doc.revision}）` : ''
      }`,
    );

    // 其它锚定段落被改动的提案（含同一段落）按规则标记冲突，不做自动三方合并。
    markConflictedProposalsForContentChange(
      db,
      proposal.documentId,
      doc.paragraphs,
      newDocument.paragraphs,
    );

    return {
      proposal: getProposal(db, proposal.id),
      document: getDocument(db, proposal.documentId),
    };
  });
}

export interface RejectProposalInput {
  reviewer?: string;
  note?: string;
}

export function rejectProposal(
  db: Db,
  proposalId: string,
  input: RejectProposalInput = {},
): Proposal {
  return transaction(db, () => {
    const proposal = getProposal(db, proposalId);
    assertActionable(proposal, '拒绝');
    const reviewer = input.reviewer?.trim() || 'reviewer';
    const at = nowIso();
    db.prepare(
      `UPDATE proposals SET status = 'rejected', decided_at = ?, reviewer = ?, updated_at = ? WHERE id = ?`,
    ).run(at, reviewer, at, proposal.id);
    appendProposalEvent(
      db,
      proposal.id,
      proposal.status,
      'rejected',
      reviewer,
      input.note?.trim() || '拒绝该建议，文档保持不变',
    );
    return getProposal(db, proposal.id);
  });
}

export interface ApplyDiscussionResult {
  newText: string;
  reason: string;
}

/**
 * 讨论完成后的落库：只更新该条提案（newText/reason，discussionCount+1，status=revised），
 * 不修改文档、不影响其它提案。
 * 注意：本函数不 BEGIN/COMMIT，调用方需包在 transaction 中。
 */
export function applyDiscussionResult(
  db: Db,
  proposalId: string,
  runId: string,
  result: ApplyDiscussionResult,
  actor = 'ai',
): Proposal {
  const proposal = getProposal(db, proposalId);
  assertActionable(proposal, '讨论修订');
  const at = nowIso();
  db.prepare(
    `UPDATE proposals SET new_text = ?, reason = ?, status = 'revised',
       discussion_count = discussion_count + 1, updated_at = ? WHERE id = ?`,
  ).run(result.newText, result.reason, at, proposal.id);
  appendProposalEvent(
    db,
    proposal.id,
    proposal.status,
    'revised',
    actor,
    `继续讨论修订（run=${runId}），仅更新该条提案`,
  );
  return getProposal(db, proposal.id);
}

/* ------------------------------------------------------------------ *
 * 异步运行编排（生成 / 讨论）
 * ------------------------------------------------------------------ */

export interface EngineDeps {
  db: Db;
  config: AppConfig;
}

function documentChapterTitle(
  blocks: ParagraphBlock[],
  targetChapterIndex: number | null,
): string | null {
  if (targetChapterIndex === null) return null;
  const block = blocks.find(
    (item) => item.chapterIndex === targetChapterIndex && item.type === 'heading',
  );
  return block ? block.text : null;
}

/** 目标章节：优先解析提示词中的“第 N 章”；mock 固定第三章；真实模型未指定时不限定。 */
export function resolveTargetChapterIndex(
  backendId: string,
  prompt: string,
): number | null {
  const parsed = chapterIndexFromPrompt(prompt);
  if (parsed !== null) return parsed;
  if (backendId === 'mock') return MOCK_TARGET_CHAPTER_INDEX;
  return null;
}

const FAULT_MAP: Record<
  string,
  { code: 'model_rate_limited' | 'model_unavailable' | 'model_timeout' | 'data_policy_blocked'; message: string }
> = {
  rate_limit: {
    code: 'model_rate_limited',
    message: '演示故障注入：模型网关返回 429（rate_limit）',
  },
  server_error: {
    code: 'model_unavailable',
    message: '演示故障注入：模型网关返回 500（server_error）',
  },
  network: {
    code: 'model_unavailable',
    message: '演示故障注入：模型网关网络中断（network）',
  },
  timeout: {
    code: 'model_timeout',
    message: '演示故障注入：模型网关请求超时（timeout）',
  },
  data_policy: {
    code: 'data_policy_blocked',
    message: '演示故障注入：数据分级禁止发送到外部模型（data_policy）',
  },
};

/** fault 仅在 config.faultInjection 开启时生效（API_CONTRACT §4.6）。 */
function maybeInjectFault(
  config: AppConfig,
  fault: string | undefined,
  emit: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void,
): void {
  if (!fault || !config.faultInjection) return;
  const mapped = FAULT_MAP[fault];
  if (!mapped) return;
  emit('warn', `已注入演示故障：${fault}`, {
    fault,
    faultInjected: true,
    errorCode: mapped.code,
  });
  const error = new LlmError(mapped.code, mapped.message, {
    retryable: mapped.code !== 'data_policy_blocked',
  });
  (error as LlmError & { fault?: string }).fault = fault;
  throw error;
}

export function assertProjectAllowsExternalModel(
  project: ProjectBrief,
  backendId: string,
): void {
  if (project.dataLevel === 'secret' && backendId !== 'mock') {
    throw new LlmError('data_policy_blocked', '项目数据分级为 secret，禁止发送到外部模型网关', {
      retryable: false,
      httpStatus: 403,
    });
  }
}

/** 数据分级阻断时仍创建一条 failed Run 供审计（HTTP 403，不产生提案）。 */
export function createBlockedRun(
  db: Db,
  input: {
    projectId: string;
    documentId: string;
    type: RunType;
    backend: string;
    provider: string;
    model: string;
    tier: string;
    prompt: string;
  },
  error: { code: string; message: string; retryable: boolean },
): Run {
  const run = runService.createRun(db, { ...input, dataPolicyId: 'data_policy:secret' });
  return runService.failRun(db, run.id, error, { retryReason: 'data_policy_blocked' });
}

function emitSafely(
  db: Db,
  runId: string,
): (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void {
  return (level, message, data) => {
    try {
      const current = runService.findRun(db, runId);
      if (!current || current.status === 'cancelled') return;
      runService.appendRunEvent(db, runId, { level, message, data });
    } catch {
      // 事件写失败不影响主流程。
    }
  };
}

export interface StartGenerationInput {
  run: Run;
  project: ProjectBrief;
  document: Document;
  request: ProposalGenerationRequest;
}

/** 创建 Run 之后调用：异步执行生成，立即返回（HTTP 202）。 */
export function startGenerationRun(deps: EngineDeps, input: StartGenerationInput): void {
  const { db, config } = deps;
  setImmediate(() => {
    void executeGeneration(db, config, input).catch((error: unknown) => {
      // 兜底：任何未捕获异常都把 Run 标 failed，绝不留下 running 悬挂。
      try {
        const current = runService.findRun(db, input.run.id);
        if (current && current.status !== 'cancelled' && !runService.isTerminalStatus(current.status)) {
          runService.failRun(db, input.run.id, toRunError(error));
        }
      } catch {
        // ignore
      }
    });
  });
}

async function executeGeneration(
  db: Db,
  config: AppConfig,
  input: StartGenerationInput,
): Promise<void> {
  const { run, project, document, request } = input;
  const started = Date.now();
  const controller = runService.registerRunAbort(run.id);
  const emit = emitSafely(db, run.id);
  let injectedFault: string | null = null;
  try {
    runService.markRunRunning(db, run.id);
    if (runService.findRun(db, run.id)?.status === 'cancelled') return;
    runService.appendRunEvent(db, run.id, {
      level: 'info',
      message: '执行器开始执行生成任务',
      data: {
        backend: run.backend,
        provider: run.provider,
        model: run.model,
        tier: request.tier,
        targetChapterIndex: resolveTargetChapterIndex(run.backend, request.prompt),
      },
    });

    assertProjectAllowsExternalModel(project, run.backend);
    try {
      maybeInjectFault(config, request.fault, emit);
    } catch (error) {
      injectedFault = request.fault ?? null;
      throw error;
    }

    const registry = createRuntimeRegistry(config);
    const backend = registry.byId(run.backend);
    if (!backend) {
      throw new LlmError('backend_unavailable', `执行器 ${run.backend} 不存在`, {
        retryable: false,
      });
    }
    const targetChapterIndex = resolveTargetChapterIndex(run.backend, request.prompt);
    const task: ExecutionTask = {
      type: 'proposal_generation',
      projectName: project.name,
      documentTitle: document.title,
      documentRevision: document.revision,
      prompt: request.prompt,
      count: request.count,
      tier: request.tier,
      targetChapterIndex,
      chapterTitle: documentChapterTitle(document.paragraphs, targetChapterIndex),
      blocks: document.paragraphs,
      references: referencesForProject(db, document.projectId),
    };

    if (runService.findRun(db, run.id)?.status === 'cancelled' || controller.signal.aborted) return;
    const result: ExecutionResult = await backend.start(task, {
      runId: run.id,
      signal: controller.signal,
      emit,
    });

    const current = runService.findRun(db, run.id);
    if (!current || current.status === 'cancelled' || controller.signal.aborted) return;
    if (!result.generation) {
      throw new LlmError('model_schema_invalid', '执行器未返回生成结果', { retryable: false });
    }

    transaction(db, () => {
      createProposalsFromDrafts(db, {
        documentId: document.id,
        runId: run.id,
        baseRevision: document.revision,
        drafts: result.generation?.proposals ?? [],
        model: result.model,
        provider: result.provider,
        backend: run.backend,
        tier: request.tier,
      });
      runService.appendRunEvent(db, run.id, {
        level: 'info',
        message: `已生成 ${result.generation?.proposals.length ?? 0} 条提案`,
        data: { proposals: result.generation?.proposals.length ?? 0, notes: result.generation?.notes ?? [] },
      });
      runService.finishRun(db, run.id, {
        latencyMs: result.latencyMs || Date.now() - started,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        retryReason: result.retryReason,
        model: result.model,
        provider: result.provider,
      });
    });
  } catch (error) {
    const current = runService.findRun(db, run.id);
    if (!current || current.status === 'cancelled' || controller.signal.aborted) return;
    const runError = toRunError(error);
    runService.failRun(db, run.id, runError, {
      latencyMs: Date.now() - started,
      retryReason: injectedFault ? `fault_injected:${injectedFault}` : undefined,
    });
  } finally {
    runService.unregisterRunAbort(run.id);
  }
}

export interface StartDiscussionInput {
  run: Run;
  project: ProjectBrief;
  document: Document;
  proposal: Proposal;
  request: ProposalDiscussionRequest;
}

export function startDiscussionRun(deps: EngineDeps, input: StartDiscussionInput): void {
  const { db, config } = deps;
  setImmediate(() => {
    void executeDiscussion(db, config, input).catch((error: unknown) => {
      try {
        const current = runService.findRun(db, input.run.id);
        if (current && current.status !== 'cancelled' && !runService.isTerminalStatus(current.status)) {
          runService.failRun(db, input.run.id, toRunError(error));
        }
      } catch {
        // ignore
      }
    });
  });
}

async function executeDiscussion(
  db: Db,
  config: AppConfig,
  input: StartDiscussionInput,
): Promise<void> {
  const { run, project, document, proposal, request } = input;
  const started = Date.now();
  const controller = runService.registerRunAbort(run.id);
  const emit = emitSafely(db, run.id);
  let injectedFault: string | null = null;
  try {
    runService.markRunRunning(db, run.id);
    if (runService.findRun(db, run.id)?.status === 'cancelled') return;
    runService.appendRunEvent(db, run.id, {
      level: 'info',
      message: '执行器开始执行讨论任务（只更新该条提案，不修改文档）',
      data: { backend: run.backend, provider: run.provider, model: run.model, tier: request.tier },
    });

    assertProjectAllowsExternalModel(project, run.backend);
    try {
      maybeInjectFault(config, request.fault, emit);
    } catch (error) {
      injectedFault = request.fault ?? null;
      throw error;
    }

    const registry = createRuntimeRegistry(config);
    const backend = registry.byId(run.backend);
    if (!backend) {
      throw new LlmError('backend_unavailable', `执行器 ${run.backend} 不存在`, {
        retryable: false,
      });
    }
    const task: DiscussionTask = {
      type: 'discussion',
      projectName: project.name,
      documentTitle: document.title,
      proposal: {
        paragraphId: proposal.paragraphId,
        oldText: proposal.oldText,
        newText: proposal.newText,
        reason: proposal.reason,
      },
      message: request.message,
      tier: request.tier,
      references: referencesForProject(db, document.projectId),
    };

    if (runService.findRun(db, run.id)?.status === 'cancelled' || controller.signal.aborted) return;
    const result = await backend.start(task, {
      runId: run.id,
      signal: controller.signal,
      emit,
    });
    const current = runService.findRun(db, run.id);
    if (!current || current.status === 'cancelled' || controller.signal.aborted) return;
    if (!result.discussion) {
      throw new LlmError('model_schema_invalid', '执行器未返回讨论结果', { retryable: false });
    }
    const discussion: DiscussionOutput = result.discussion;

    transaction(db, () => {
      applyDiscussionResult(db, proposal.id, run.id, discussion);
      runService.finishRun(db, run.id, {
        latencyMs: result.latencyMs || Date.now() - started,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        retryReason: result.retryReason,
        model: result.model,
        provider: result.provider,
      });
    });
  } catch (error) {
    const current = runService.findRun(db, run.id);
    if (!current || current.status === 'cancelled' || controller.signal.aborted) return;
    runService.failRun(db, run.id, toRunError(error), {
      latencyMs: Date.now() - started,
      retryReason: injectedFault ? `fault_injected:${injectedFault}` : undefined,
    });
  } finally {
    runService.unregisterRunAbort(run.id);
  }
}

/** 生成 Run 的 provider/model 解析（路由创建 Run 时使用）。 */
export function resolveRunProviderModel(
  config: AppConfig,
  backendId: 'dsh' | 'mock',
  tier: TierName,
): { provider: string; model: string } {
  if (backendId === 'mock') return { provider: 'mock', model: MOCK_MODEL };
  const registry = createRuntimeRegistry(config);
  const provider = registry.llmRouter.defaultProvider();
  return {
    provider: provider.id,
    model: registry.llmRouter.modelFor(provider.id, tier),
  };
}
