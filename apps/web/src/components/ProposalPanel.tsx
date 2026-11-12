/** 右侧建议面板：建议卡片列表 + 状态统计 + 多选批量采纳 + 刷新。 */
import type { BatchAcceptResult, Citation, Proposal } from '../api/types';
import type { ProposalCardProps } from './ProposalCard';
import { ProposalCard } from './ProposalCard';
import { AlertIcon, CheckIcon, RefreshIcon, SparklesIcon } from './Icons';
import { shortId } from '../utils/format';

export interface ProposalPanelProps {
  proposals: Proposal[];
  loading: boolean;
  error: string | null;
  busyProposalId: string | null;
  selectedProposalIds: string[];
  batchBusy: boolean;
  batchError: string | null;
  batchResult: BatchAcceptResult | null;
  locateNotices: Record<string, string>;
  onToggleSelect: (proposal: Proposal) => void;
  onSelectAllPending: () => void;
  onBatchAccept: () => void;
  onDismissBatchResult: () => void;
  onAccept: ProposalCardProps['onAccept'];
  onReject: ProposalCardProps['onReject'];
  onDiscuss: ProposalCardProps['onDiscuss'];
  onLocate: ProposalCardProps['onLocate'];
  onOpenCitation: (citation: Citation) => void;
  onRefresh: () => void;
}

function isPending(proposal: Proposal): boolean {
  return proposal.status === 'proposed' || proposal.status === 'revised';
}

export function ProposalPanel({
  proposals,
  loading,
  error,
  busyProposalId,
  selectedProposalIds,
  batchBusy,
  batchError,
  batchResult,
  locateNotices,
  onToggleSelect,
  onSelectAllPending,
  onBatchAccept,
  onDismissBatchResult,
  onAccept,
  onReject,
  onDiscuss,
  onLocate,
  onOpenCitation,
  onRefresh,
}: ProposalPanelProps) {
  const counts = {
    proposed: proposals.filter((item) => item.status === 'proposed').length,
    revised: proposals.filter((item) => item.status === 'revised').length,
    accepted: proposals.filter((item) => item.status === 'accepted').length,
    rejected: proposals.filter((item) => item.status === 'rejected').length,
    conflicted: proposals.filter((item) => item.status === 'conflicted').length,
  };
  const pending = counts.proposed + counts.revised;
  const pendingIds = proposals.filter(isPending).map((proposal) => proposal.id);
  const selectedCount = selectedProposalIds.filter((id) => pendingIds.includes(id)).length;
  const allSelected = pendingIds.length > 0 && selectedCount === pendingIds.length;
  const batchOk = batchResult?.results.filter((result) => result.ok).length ?? 0;
  const batchFailed = (batchResult?.results.length ?? 0) - batchOk;

  return (
    <aside className="right-panel" data-testid="proposal-panel">
      <div className="right-panel-head">
        <div className="right-panel-title">
          <SparklesIcon size={16} />
          <h2>建议卡片</h2>
          <span className="count-badge" data-testid="proposal-count">
            {proposals.length}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          title="刷新建议列表"
          aria-label="刷新建议列表"
          data-testid="btn-refresh-proposals"
          onClick={onRefresh}
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      <div className="proposal-summary">
        <span className="summary-item summary-pending" data-testid="summary-pending">
          待审 {pending}
        </span>
        <span className="summary-item summary-accepted">已采纳 {counts.accepted}</span>
        <span className="summary-item summary-rejected">已拒绝 {counts.rejected}</span>
        <span className="summary-item summary-conflicted">冲突 {counts.conflicted}</span>
      </div>

      <div className="batch-bar" data-testid="batch-bar">
        <label className="batch-select-all" title="全选/取消全选待审与修订中的建议">
          <input
            type="checkbox"
            data-testid="batch-select-all"
            checked={allSelected}
            disabled={pendingIds.length === 0}
            onChange={onSelectAllPending}
          />
          全选待审
        </label>
        <span className="batch-count" data-testid="batch-count">
          已选 {selectedCount} 条
        </span>
        <button
          type="button"
          className="btn btn-batch"
          data-testid="btn-batch-accept"
          disabled={selectedCount === 0 || batchBusy}
          title="批量采纳选中建议：逐条服务端校验，单条冲突/失败不影响其余"
          onClick={onBatchAccept}
        >
          {batchBusy ? <span className="spinner spinner-sm spinner-light" /> : <CheckIcon size={13} />}
          {batchBusy ? '批量采纳中…' : `批量采纳${selectedCount > 0 ? `（${selectedCount}）` : ''}`}
        </button>
      </div>

      {error ? <p className="inline-error right-panel-error">建议加载失败：{error}</p> : null}
      {batchError ? (
        <p className="inline-error right-panel-error" data-testid="batch-error">
          批量采纳失败：{batchError}
        </p>
      ) : null}

      {batchResult ? (
        <div className="batch-results" data-testid="batch-results">
          <div className="batch-results-head">
            <strong>批量采纳结果</strong>
            <span className="batch-results-summary" data-testid="batch-results-summary">
              成功 {batchOk} · 失败/冲突 {batchFailed}
            </span>
            <button type="button" className="icon-btn" aria-label="关闭批量结果" data-testid="btn-dismiss-batch" onClick={onDismissBatchResult}>
              ×
            </button>
          </div>
          <ul>
            {batchResult.results.map((result) => (
              <li
                key={result.id}
                className={`batch-result-item ${result.ok ? 'is-ok' : 'is-fail'}`}
                data-testid="batch-result-item"
                data-ok={result.ok ? 'true' : 'false'}
              >
                {result.ok ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
                <span className="batch-result-id">{shortId(result.id)}</span>
                <span className="batch-result-status">
                  {result.ok ? `已采纳（${result.status ?? 'accepted'}）` : `失败${result.status ? `（${result.status}）` : ''}`}
                </span>
                {result.error ? <span className="batch-result-error">{result.error}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="proposal-list" data-testid="proposal-list">
        {loading && proposals.length === 0 ? (
          <div className="proposal-empty">
            <span className="spinner" />
            <p>正在加载建议…</p>
          </div>
        ) : proposals.length === 0 ? (
          <div className="proposal-empty" data-testid="proposal-empty">
            <SparklesIcon size={26} />
            <p>暂无建议。</p>
            <p className="proposal-empty-hint">
              在左侧输入对话（可 @ 引用资料），点击「生成建议」。AI 只提交建议，不会直接改正文。
            </p>
          </div>
        ) : (
          proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              busy={busyProposalId === proposal.id}
              selected={selectedProposalIds.includes(proposal.id)}
              onToggleSelect={onToggleSelect}
              onAccept={onAccept}
              onReject={onReject}
              onDiscuss={onDiscuss}
              onLocate={onLocate}
              onOpenCitation={onOpenCitation}
              locateNotice={locateNotices[proposal.id] ?? null}
            />
          ))
        )}
      </div>
    </aside>
  );
}
