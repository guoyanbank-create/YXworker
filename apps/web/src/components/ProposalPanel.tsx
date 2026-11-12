/** 右侧建议面板：建议卡片列表 + 状态统计 + 刷新。 */
import type { Proposal } from '../api/types';
import type { ProposalCardProps } from './ProposalCard';
import { ProposalCard } from './ProposalCard';
import { RefreshIcon, SparklesIcon } from './Icons';

export interface ProposalPanelProps {
  proposals: Proposal[];
  loading: boolean;
  error: string | null;
  busyProposalId: string | null;
  onAccept: ProposalCardProps['onAccept'];
  onReject: ProposalCardProps['onReject'];
  onDiscuss: ProposalCardProps['onDiscuss'];
  onLocate: ProposalCardProps['onLocate'];
  onRefresh: () => void;
}

export function ProposalPanel({
  proposals,
  loading,
  error,
  busyProposalId,
  onAccept,
  onReject,
  onDiscuss,
  onLocate,
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

      {error ? <p className="inline-error right-panel-error">建议加载失败：{error}</p> : null}

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
              onAccept={onAccept}
              onReject={onReject}
              onDiscuss={onDiscuss}
              onLocate={onLocate}
            />
          ))
        )}
      </div>
    </aside>
  );
}
