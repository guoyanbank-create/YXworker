/**
 * P2 ImpactPlan 面板：选择待审提案 → 请求影响分析（受影响章节/图表/功能/提案）
 * → 确认后批量执行（逐条采纳，逐条结果可见）。
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api/client';
import { errorMessage, isApiError } from '../api/client';
import type { BatchAcceptResult, ImpactPlan, Proposal } from '../api/types';
import { PROPOSAL_STATUS_LABELS } from '../api/types';
import { formatDateTime, shortId, truncate } from '../utils/format';
import {
  AlertIcon,
  CheckIcon,
  CheckSquareIcon,
  CloseIcon,
  ImpactIcon,
  RefreshIcon,
} from './Icons';

export interface ImpactPanelProps {
  documentId: string | null;
  documentRevision: number | null;
  proposals: Proposal[];
  onExecuted: (result: { plan: ImpactPlan; batch: BatchAcceptResult }) => void;
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

function isPending(proposal: Proposal): boolean {
  return proposal.status === 'proposed' || proposal.status === 'revised';
}

function codePrefix(error: unknown): string {
  return isApiError(error) ? `[${error.code}] ` : '';
}

export function ImpactPanel({
  documentId,
  documentRevision,
  proposals,
  onExecuted,
  onToast,
}: ImpactPanelProps) {
  const pending = useMemo(() => proposals.filter(isPending), [proposals]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<ImpactPlan | null>(null);
  const [building, setBuilding] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchAcceptResult | null>(null);

  // 提案列表变化时：保留仍待审的已选，若一个都没选则默认全选（便于演示）。
  useEffect(() => {
    setSelectedIds((prev) => {
      const pendingIds = pending.map((proposal) => proposal.id);
      const kept = prev.filter((id) => pendingIds.includes(id));
      return kept.length > 0 ? kept : pendingIds;
    });
  }, [pending]);

  useEffect(() => {
    setPlan(null);
    setBatch(null);
    setError(null);
  }, [documentId]);

  function toggle(id: string): void {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  async function handleBuild(): Promise<void> {
    if (!documentId) return;
    if (selectedIds.length === 0) {
      setError('请至少选择一条待审提案。');
      return;
    }
    setBuilding(true);
    setError(null);
    setBatch(null);
    try {
      const { plan: created } = await api.createImpactPlan(documentId, {
        proposalIds: selectedIds,
        trigger: 'manual',
      });
      setPlan(created);
      onToast(`影响分析完成：${created.affected.chapters.length} 个章节、${created.affected.diagrams.length} 张图表、${created.affected.featureSpecs.length} 项功能受影响。`, 'success');
    } catch (buildError) {
      setPlan(null);
      setError(`${codePrefix(buildError)}${errorMessage(buildError)}`);
      onToast(`影响分析失败：${errorMessage(buildError)}`, 'error');
    } finally {
      setBuilding(false);
    }
  }

  async function handleExecute(): Promise<void> {
    if (!plan) return;
    setExecuting(true);
    setError(null);
    try {
      const result = await api.executeImpactPlan(plan.id, plan.affected.proposals.map((item) => item.id));
      setPlan(result.plan);
      setBatch(result.batch);
      const okCount = result.batch.results.filter((item) => item.ok).length;
      const failed = result.batch.results.length - okCount;
      onExecuted(result);
      onToast(`影响计划执行完成：成功 ${okCount} 条${failed > 0 ? `，失败/冲突 ${failed} 条` : ''}。`, failed > 0 ? 'error' : 'success');
    } catch (executeError) {
      setError(`${codePrefix(executeError)}${errorMessage(executeError)}`);
      onToast(`执行影响计划失败：${errorMessage(executeError)}`, 'error');
    } finally {
      setExecuting(false);
    }
  }

  const executed = plan?.executedAt != null || batch != null;

  return (
    <section className="p2-panel impact-panel" data-testid="impact-panel">
      <header className="p2-panel-head">
        <div className="p2-panel-title">
          <ImpactIcon size={16} />
          <h2>影响分析（ImpactPlan）</h2>
          {plan ? <span className="count-badge">{plan.affected.proposals.length}</span> : null}
        </div>
        <div className="p2-panel-actions">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-testid="btn-refresh-impact"
            onClick={() => void handleBuild()}
            disabled={building || executing}
          >
            <RefreshIcon size={13} />
            重新分析
          </button>
          <button
            type="button"
            className="btn btn-primary btn-xs"
            data-testid="btn-build-impact"
            onClick={() => void handleBuild()}
            disabled={building || executing || selectedIds.length === 0}
          >
            {building ? (
              <>
                <span className="spinner spinner-sm spinner-light" />
                分析中…
              </>
            ) : (
              <>
                <ImpactIcon size={13} />
                构建影响计划
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn-execute btn-xs"
            data-testid="btn-execute-impact"
            onClick={() => void handleExecute()}
            disabled={!plan || executed || executing}
            title="确认后批量采纳计划内的提案（逐条执行，单条失败不影响其余）"
          >
            {executing ? (
              <>
                <span className="spinner spinner-sm spinner-light" />
                执行中…
              </>
            ) : (
              <>
                <CheckSquareIcon size={13} />
                确认并批量执行
              </>
            )}
          </button>
        </div>
      </header>

      <p className="p2-panel-hint">
        先选择待审提案并构建影响计划，确认受影响章节/图表/功能后再执行；执行等同批量采纳，逐条服务端校验，单条冲突/失败不阻断其余。
        当前文档 revision {documentRevision ?? '—'}。
      </p>

      {error ? (
        <p className="inline-error p2-panel-error" data-testid="impact-error">
          {error}
        </p>
      ) : null}

      <div className="impact-layout">
        <div className="impact-select" data-testid="impact-select">
          <div className="impact-select-head">
            <span className="field-label">纳入计划的待审提案（{selectedIds.length}/{pending.length}）</span>
            <button
              type="button"
              className="btn btn-tiny"
              onClick={() => setSelectedIds(pending.map((proposal) => proposal.id))}
              disabled={pending.length === 0}
            >
              全选
            </button>
          </div>
          {pending.length === 0 ? (
            <p className="p2-empty">当前没有待审/修订中的提案。先在左侧生成建议。</p>
          ) : (
            <ul className="impact-proposal-list">
              {pending.map((proposal) => (
                <li key={proposal.id}>
                  <label className="impact-proposal-item">
                    <input
                      type="checkbox"
                      data-testid="impact-select-item"
                      data-proposal-id={proposal.id}
                      checked={selectedIds.includes(proposal.id)}
                      onChange={() => toggle(proposal.id)}
                    />
                    <span className="impact-proposal-main">
                      <span className="impact-proposal-title">
                        {proposal.chapterTitle || '（未命名章节）'}
                        <span className="impact-proposal-id">{shortId(proposal.id)}</span>
                      </span>
                      <span className="impact-proposal-quote">− {truncate(proposal.oldText, 56)}</span>
                      <span className="impact-proposal-quote impact-new">+ {truncate(proposal.newText, 56)}</span>
                    </span>
                    <span className={`pill status-${proposal.status}`}>
                      {PROPOSAL_STATUS_LABELS[proposal.status]}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="impact-result" data-testid="impact-plan">
          {!plan ? (
            <div className="p2-empty">
              <ImpactIcon size={26} />
              <p>尚未构建影响计划。</p>
              <p>选择待审提案后点击「构建影响计划」，先看影响范围再决定是否执行。</p>
            </div>
          ) : (
            <>
              <div className="impact-meta">
                <span data-testid="impact-plan-id">计划 {shortId(plan.id)}</span>
                <span>基准 revision {plan.baseRevision}</span>
                <span>触发：{plan.trigger}</span>
                <span>{formatDateTime(plan.createdAt)}</span>
                {plan.executedAt ? (
                  <span className="pill pill-executed" data-testid="impact-executed">
                    <CheckIcon size={11} /> 已执行 {formatDateTime(plan.executedAt)}
                  </span>
                ) : (
                  <span className="pill pill-pending">待确认执行</span>
                )}
              </div>

              <div className="impact-section">
                <h3>
                  受影响章节<span className="count-badge">{plan.affected.chapters.length}</span>
                </h3>
                {plan.affected.chapters.length === 0 ? (
                  <p className="p2-empty">无受影响章节。</p>
                ) : (
                  <ul className="impact-chapter-list">
                    {plan.affected.chapters.map((chapter) => (
                      <li key={`${chapter.chapterIndex}-${chapter.chapterTitle}`} className="impact-chapter" data-testid="impact-chapter">
                        <span className="impact-chapter-title">{chapter.chapterTitle || `第 ${chapter.chapterIndex + 1} 章`}</span>
                        <span className="impact-chapter-meta">{chapter.paragraphCount} 段 · {chapter.paragraphIds.length} 个提案目标段落</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="impact-section">
                <h3>
                  受影响图表<span className="count-badge">{plan.affected.diagrams.length}</span>
                </h3>
                {plan.affected.diagrams.length === 0 ? (
                  <p className="p2-empty">无受影响图表。</p>
                ) : (
                  <ul className="impact-reason-list">
                    {plan.affected.diagrams.map((item) => (
                      <li key={item.diagram.id} className="impact-reason-item" data-testid="impact-diagram">
                        <span className="impact-reason-title">{item.diagram.title}</span>
                        <span className="impact-reason-text">{item.reason}</span>
                        <span className="impact-binding">
                          绑定：{item.diagram.versionName ?? `当前 rev ${item.diagram.documentRevision ?? '—'}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="impact-section">
                <h3>
                  受影响功能<span className="count-badge">{plan.affected.featureSpecs.length}</span>
                </h3>
                {plan.affected.featureSpecs.length === 0 ? (
                  <p className="p2-empty">无受影响功能。</p>
                ) : (
                  <ul className="impact-reason-list">
                    {plan.affected.featureSpecs.map((item) => (
                      <li key={item.feature.id} className="impact-reason-item" data-testid="impact-feature">
                        <span className="impact-reason-title">{item.feature.title}</span>
                        <span className="impact-reason-text">{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="impact-section">
                <h3>
                  计划内提案<span className="count-badge">{plan.affected.proposals.length}</span>
                </h3>
                <ul className="impact-proposal-snapshot">
                  {plan.affected.proposals.map((proposal) => (
                    <li key={proposal.id} data-testid="impact-plan-proposal">
                      <span className={`pill status-${proposal.status}`}>{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
                      <span className="impact-plan-proposal-id">{shortId(proposal.id)}</span>
                      <span className="impact-plan-proposal-text">{truncate(proposal.newText, 80)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {batch ? (
                <div className="impact-batch" data-testid="impact-batch-results">
                  <h3>
                    逐条执行结果
                    <span className="count-badge">{batch.results.filter((item) => item.ok).length}/{batch.results.length} 成功</span>
                  </h3>
                  <ul>
                    {batch.results.map((result) => (
                      <li
                        key={result.id}
                        className={`impact-batch-item ${result.ok ? 'is-ok' : 'is-fail'}`}
                        data-testid="impact-result-item"
                        data-ok={result.ok ? 'true' : 'false'}
                      >
                        {result.ok ? <CheckIcon size={13} /> : <AlertIcon size={13} />}
                        <span className="impact-batch-id">{shortId(result.id)}</span>
                        <span className="impact-batch-status">
                          {result.ok ? `已采纳（${result.status ?? 'accepted'}）` : `失败${result.status ? `（${result.status}）` : ''}`}
                        </span>
                        {result.error ? <span className="impact-batch-error">{result.error}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
