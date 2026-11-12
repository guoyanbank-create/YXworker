/**
 * ImpactPlan 服务（P2）：先展示影响、再逐项执行。
 *
 * 契约（docs/API_CONTRACT.md P2-7 / P2-8）：
 * - 影响章节：纳入计划的提案目标段落按 `chapterIndex` 聚合；
 * - 受影响图表：`diagram.chapterRef` 命中受影响章节标题，或
 *   `diagram.documentRevision < document.revision`（绑定版本落后，需同步）；
 * - 受影响功能：`feature.chapterRef` 命中受影响章节，或 `feature.diagramId` 命中受影响图表；
 * - 执行 / 批量采纳：逐条服务端校验，单条失败只记录 error 不阻断其余，返回最新文档。
 *
 * 事务约定：本模块不自行 BEGIN；`acceptProposal` 内部已按单条提案使用事务，
 * 因此批量采纳不能套外层事务（SQLite 不支持事务嵌套），每条提案各自原子提交。
 */
import type { Db } from '../db.js';
import { newId, nowIso } from '../db.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import type {
  BatchAcceptItemResult,
  BatchAcceptResult,
  Document,
  ImpactAffectedChapter,
  ImpactAffectedDiagrams,
  ImpactAffectedFeatures,
  ImpactPlan,
  Proposal,
} from '../types.js';
import { getDocument } from './documentsService.js';
import { listDiagrams } from './diagramsService.js';
import { listFeatures } from './featuresService.js';
import { acceptProposal, findProposal, listProposals } from './proposalService.js';

export interface CreateImpactPlanInput {
  /** 不传 = 文档下所有 proposed/revised 提案。 */
  proposalIds?: string[];
  trigger?: string;
}

export interface ExecuteImpactPlanInput {
  /** 不传 = 计划内的全部提案快照。 */
  proposalIds?: string[];
  /** 作为采纳操作者记录（契约未要求，UI 可传当前审阅人）。 */
  reviewer?: string;
}

export interface ExecuteImpactPlanResult {
  plan: ImpactPlan;
  batch: BatchAcceptResult;
}

interface ImpactPlanRow {
  id: string;
  document_id: string;
  base_revision: number;
  trigger: string;
  affected_json: string;
  created_at: string;
  executed_at: string | null;
}

const PLAN_COLUMNS =
  'id, document_id, base_revision, trigger, affected_json, created_at, executed_at';

/** 纳入影响分析的提案：显式 ids 必须属于该文档；默认全部 proposed/revised。 */
function resolveProposals(
  db: Db,
  documentId: string,
  proposalIds: string[] | undefined,
): Proposal[] {
  const actionable = (proposal: Proposal): boolean =>
    proposal.status === 'proposed' || proposal.status === 'revised';
  if (proposalIds === undefined) {
    return listProposals(db, documentId).filter(actionable);
  }
  const seen = new Set<string>();
  const selected: Proposal[] = [];
  for (const id of proposalIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const proposal = findProposal(db, id);
    if (!proposal || proposal.documentId !== documentId) {
      throw badRequest('validation_error', `提案不存在或不属于该文档: ${id}`, { proposalId: id });
    }
    selected.push(proposal);
  }
  return selected;
}

/** 提案目标段落 → 受影响章节（按 chapterIndex 升序聚合，段落 id 去重）。 */
function aggregateChapters(
  document: Document,
  proposals: Proposal[],
): ImpactAffectedChapter[] {
  const byChapter = new Map<
    number,
    { chapterTitle: string; paragraphIds: Set<string> }
  >();
  for (const proposal of proposals) {
    // 优先按 paragraphId 定位；目标段落被删除时退回提案记录的 paragraphIndex。
    const block =
      document.paragraphs.find((item) => item.id === proposal.paragraphId) ??
      document.paragraphs[proposal.paragraphIndex];
    const chapterIndex = block ? block.chapterIndex : -1;
    const chapterTitle = block ? block.chapterTitle : proposal.chapterTitle || '（未知章节）';
    const entry = byChapter.get(chapterIndex) ?? {
      chapterTitle,
      paragraphIds: new Set<string>(),
    };
    entry.paragraphIds.add(proposal.paragraphId);
    byChapter.set(chapterIndex, entry);
  }
  return [...byChapter.entries()]
    .sort(([a], [b]) => a - b)
    .map(([chapterIndex, entry]) => ({
      chapterIndex,
      chapterTitle: entry.chapterTitle,
      paragraphIds: [...entry.paragraphIds],
      paragraphCount: entry.paragraphIds.size,
    }));
}

function listAffectedDiagrams(
  db: Db,
  projectId: string,
  document: Document,
  affectedChapterTitles: Set<string>,
): ImpactAffectedDiagrams[] {
  const affected: ImpactAffectedDiagrams[] = [];
  for (const diagram of listDiagrams(db, projectId)) {
    const reasons: string[] = [];
    if (diagram.chapterRef !== null && affectedChapterTitles.has(diagram.chapterRef)) {
      reasons.push(`图表关联章节「${diagram.chapterRef}」受本次提案影响`);
    }
    if (
      diagram.documentRevision !== null &&
      diagram.documentRevision < document.revision
    ) {
      reasons.push(
        `图表绑定的文档版本（revision ${diagram.documentRevision}）落后于当前 revision ${document.revision}，需同步`,
      );
    }
    if (reasons.length > 0) {
      affected.push({ diagram, reason: reasons.join('；') });
    }
  }
  return affected;
}

function listAffectedFeatures(
  db: Db,
  projectId: string,
  affectedChapterTitles: Set<string>,
  diagrams: ImpactAffectedDiagrams[],
): ImpactAffectedFeatures[] {
  const diagramById = new Map(diagrams.map((item) => [item.diagram.id, item.diagram]));
  const affected: ImpactAffectedFeatures[] = [];
  for (const feature of listFeatures(db, projectId)) {
    const reasons: string[] = [];
    if (feature.chapterRef !== null && affectedChapterTitles.has(feature.chapterRef)) {
      reasons.push(`功能关联章节「${feature.chapterRef}」受本次提案影响`);
    }
    if (feature.diagramId !== null && diagramById.has(feature.diagramId)) {
      const diagram = diagramById.get(feature.diagramId);
      reasons.push(`功能关联的图表「${diagram?.title ?? feature.diagramId}」受影响`);
    }
    if (reasons.length > 0) {
      affected.push({ feature, reason: reasons.join('；') });
    }
  }
  return affected;
}

function mapPlanRow(row: ImpactPlanRow): ImpactPlan {
  return {
    id: row.id,
    documentId: row.document_id,
    baseRevision: Number(row.base_revision),
    trigger: row.trigger,
    affected: JSON.parse(row.affected_json) as ImpactPlan['affected'],
    createdAt: row.created_at,
    executedAt: row.executed_at,
  };
}

export function getImpactPlan(db: Db, id: string): ImpactPlan {
  const row = db
    .prepare(`SELECT ${PLAN_COLUMNS} FROM impact_plans WHERE id = ?`)
    .get(id) as unknown as ImpactPlanRow | undefined;
  if (!row) throw notFound('not_found', `影响计划不存在: ${id}`);
  return mapPlanRow(row);
}

/** 计算并落库影响计划（只读计算 + 单条 INSERT，不需要事务）。 */
export function createImpactPlan(
  db: Db,
  documentId: string,
  input: CreateImpactPlanInput = {},
): ImpactPlan {
  const document = getDocument(db, documentId);
  const proposals = resolveProposals(db, documentId, input.proposalIds);
  const chapters = aggregateChapters(document, proposals);
  const affectedChapterTitles = new Set(chapters.map((chapter) => chapter.chapterTitle));
  const diagrams = listAffectedDiagrams(db, document.projectId, document, affectedChapterTitles);
  const featureSpecs = listAffectedFeatures(
    db,
    document.projectId,
    affectedChapterTitles,
    diagrams,
  );

  const plan: ImpactPlan = {
    id: newId('imp'),
    documentId,
    baseRevision: document.revision,
    trigger: input.trigger?.trim() || 'manual',
    affected: { chapters, proposals, diagrams, featureSpecs },
    createdAt: nowIso(),
    executedAt: null,
  };
  db.prepare(
    `INSERT INTO impact_plans (id, document_id, base_revision, trigger, affected_json, created_at, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    plan.id,
    plan.documentId,
    plan.baseRevision,
    plan.trigger,
    JSON.stringify(plan.affected),
    plan.createdAt,
  );
  return getImpactPlan(db, plan.id);
}

/**
 * 批量采纳（API_CONTRACT P2-8）：逐条调用服务端权威采纳；
 * 单条 409/422/404 只记录到 results.error，不阻断其余条目，最后返回最新文档。
 */
export function batchAcceptProposals(
  db: Db,
  documentId: string,
  ids: string[],
  reviewer?: string,
): BatchAcceptResult {
  getDocument(db, documentId); // 文档不存在时先 404
  const results: BatchAcceptItemResult[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      results.push({
        id,
        ok: false,
        status: findProposal(db, id)?.status ?? null,
        error: '重复的提案 id，已跳过',
      });
      continue;
    }
    seen.add(id);

    const found = findProposal(db, id);
    if (!found) {
      results.push({ id, ok: false, status: null, error: '提案不存在' });
      continue;
    }
    if (found.documentId !== documentId) {
      results.push({
        id,
        ok: false,
        status: found.status,
        error: '提案不属于该文档，已跳过',
      });
      continue;
    }

    try {
      // acceptProposal 内部按单条提案使用事务：成功/失败互不影响。
      const accepted = acceptProposal(db, id, { reviewer });
      results.push({ id, ok: true, status: accepted.proposal.status, error: null });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const current = findProposal(db, id);
      results.push({
        id,
        ok: false,
        status: current?.status ?? found.status,
        error: error.message,
      });
    }
  }
  return { results, document: getDocument(db, documentId) };
}

/**
 * 执行影响计划：对计划内提案批量采纳，任一条成功即记录 executedAt。
 * 计划快照之外的 proposalIds 视为非法参数（400），与契约「计划内逐项执行」一致。
 */
export function executeImpactPlan(
  db: Db,
  planId: string,
  input: ExecuteImpactPlanInput = {},
): ExecuteImpactPlanResult {
  const plan = getImpactPlan(db, planId);
  const planProposalIds = new Set(plan.affected.proposals.map((proposal) => proposal.id));
  let ids = plan.affected.proposals.map((proposal) => proposal.id);
  if (input.proposalIds !== undefined) {
    const seen = new Set<string>();
    ids = [];
    for (const id of input.proposalIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!planProposalIds.has(id)) {
        throw badRequest('validation_error', `提案不在该影响计划内: ${id}`, { proposalId: id });
      }
      ids.push(id);
    }
  }

  const batch = batchAcceptProposals(db, plan.documentId, ids, input.reviewer);
  let executedAt = plan.executedAt;
  if (batch.results.some((result) => result.ok)) {
    executedAt = nowIso();
    db.prepare('UPDATE impact_plans SET executed_at = ? WHERE id = ?').run(executedAt, planId);
  }
  return { plan: getImpactPlan(db, planId), batch };
}
