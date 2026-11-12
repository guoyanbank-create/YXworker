/** 建议卡片：范围、删除/新增对比、原因、引用、状态、采纳/拒绝/继续讨论/定位、冲突态。 */
import { useState } from 'react';
import type { Citation, Proposal, ProposalStatus } from '../api/types';
import { PROPOSAL_STATUS_LABELS } from '../api/types';
import { backendLabel } from '../utils/format';
import { AlertIcon, CheckIcon, CloseIcon, LocateIcon, QuoteIcon, SimulatedIcon } from './Icons';

export interface ProposalCardProps {
  proposal: Proposal;
  busy: boolean;
  /** P2：批量采纳多选（仅待审/修订中可勾选）。 */
  selected: boolean;
  onToggleSelect: (proposal: Proposal) => void;
  onAccept: (proposal: Proposal) => void;
  onReject: (proposal: Proposal) => void;
  onDiscuss: (proposal: Proposal, message: string) => void;
  onLocate: (proposal: Proposal) => void;
  /** P1：点开引用来源弹窗。 */
  onOpenCitation: (citation: Citation) => void;
  /** P1：定位兜底提示（如“段落已变化”）。 */
  locateNotice?: string | null;
}

const STATUS_CLASS: Record<ProposalStatus, string> = {
  proposed: 'status-proposed',
  revised: 'status-revised',
  accepted: 'status-accepted',
  rejected: 'status-rejected',
  conflicted: 'status-conflicted',
};

function isActionable(status: ProposalStatus): boolean {
  return status === 'proposed' || status === 'revised';
}

function CitationItem({ citation, onOpen }: { citation: Citation; onOpen: (citation: Citation) => void }) {
  return (
    <li className="citation" data-testid="proposal-citation">
      <button
        type="button"
        className="citation-button"
        data-testid="citation-open"
        data-reference-id={citation.referenceId}
        title="打开引用来源（定位 + 高亮摘录）"
        onClick={() => onOpen(citation)}
      >
        <span className="citation-head">
          <QuoteIcon size={12} />
          <span className="citation-title">{citation.title}</span>
          <span className="citation-locator">{citation.locator}</span>
          <span className="citation-open-hint">打开来源</span>
        </span>
        <span className="citation-excerpt">{citation.excerpt}</span>
      </button>
    </li>
  );
}

export function ProposalCard({
  proposal,
  busy,
  selected,
  onToggleSelect,
  onAccept,
  onReject,
  onDiscuss,
  onLocate,
  onOpenCitation,
  locateNotice,
}: ProposalCardProps) {
  const [discussOpen, setDiscussOpen] = useState(false);
  const [discussText, setDiscussText] = useState('');

  const actionable = isActionable(proposal.status);
  const conflicted = proposal.status === 'conflicted';
  const scopeParagraph = proposal.paragraphIndex >= 0 ? `第 ${proposal.paragraphIndex + 1} 段` : '目标段落';
  const mock = proposal.backend === 'mock';

  return (
    <article
      className={`proposal-card ${STATUS_CLASS[proposal.status]}`}
      data-testid="proposal-card"
      data-proposal-id={proposal.id}
      data-status={proposal.status}
    >
      <header className="proposal-head">
        {actionable ? (
          <label className="proposal-select" title="选择该建议以批量采纳">
            <input
              type="checkbox"
              data-testid="batch-select"
              data-proposal-id={proposal.id}
              checked={selected}
              onChange={() => onToggleSelect(proposal)}
            />
          </label>
        ) : null}
        <div className="proposal-scope">
          <span className="proposal-chapter" title={proposal.chapterTitle}>
            {proposal.chapterTitle || '（未命名章节）'}
          </span>
          <span className="proposal-paragraph">{scopeParagraph}</span>
        </div>
        <span className={`pill ${STATUS_CLASS[proposal.status]}`} data-testid="proposal-status">
          {PROPOSAL_STATUS_LABELS[proposal.status]}
        </span>
      </header>

      <div className="proposal-diff" data-testid="proposal-diff">
        <div className="diff-block diff-remove">
          <div className="diff-label">
            <span className="diff-mark">−</span> 删除
          </div>
          <div className="diff-text diff-old">{proposal.oldText || '（空段落）'}</div>
        </div>
        <div className="diff-block diff-add">
          <div className="diff-label">
            <span className="diff-mark">+</span> 新增
          </div>
          <div className="diff-text diff-new">{proposal.newText || '（删除该段落内容）'}</div>
        </div>
      </div>

      <div className="proposal-reason">
        <span className="proposal-field-label">原因</span>
        <p>{proposal.reason || '（无说明）'}</p>
      </div>

      {proposal.citations.length > 0 ? (
        <div className="proposal-citations" data-testid="proposal-citations">
          <span className="proposal-field-label">引用根据</span>
          <ul>
            {proposal.citations.map((citation, index) => (
              <CitationItem
                key={`${citation.referenceId}-${index}`}
                citation={citation}
                onOpen={onOpenCitation}
              />
            ))}
          </ul>
        </div>
      ) : (
        <p className="proposal-no-citation">未关联引用资料。</p>
      )}

      <div className="proposal-meta">
        <span className={`pill ${mock ? 'pill-mock' : 'pill-real'}`}>
          {mock ? <SimulatedIcon size={11} /> : null}
          {mock ? '模拟' : backendLabel(proposal.backend)}
        </span>
        <span className="proposal-meta-item" title="模型">
          {proposal.model || '—'}
        </span>
        <span className="proposal-meta-item" title="逻辑档位">
          {proposal.tier || '—'}
        </span>
        <span className="proposal-meta-item" title="继续讨论次数">
          讨论 {proposal.discussionCount} 次
        </span>
      </div>

      {conflicted ? (
        <div className="proposal-conflict" data-testid="proposal-conflict">
          <strong>冲突：目标段落已被人工修改，禁止覆盖。</strong>
          <p>{proposal.conflictReason || '该建议基于旧版段落文本生成，已失效。'}</p>
          <p className="proposal-conflict-hint">可拒绝该建议，或继续讨论让 AI 基于最新文本重新给出建议。</p>
        </div>
      ) : null}

      {proposal.status === 'accepted' ? (
        <p className="proposal-decided">已采纳并写入文档；其余建议不受影响。</p>
      ) : null}
      {proposal.status === 'rejected' ? <p className="proposal-decided">已拒绝，原文未修改。</p> : null}

      <footer className="proposal-actions">
        <button
          type="button"
          className="btn btn-accept"
          data-testid="btn-accept"
          disabled={!actionable || busy}
          title={conflicted ? '目标段落已变化，禁止覆盖' : '采纳并写入文档'}
          onClick={() => onAccept(proposal)}
        >
          <CheckIcon size={13} />
          采纳
        </button>
        <button
          type="button"
          className="btn btn-reject"
          data-testid="btn-reject"
          disabled={!actionable || busy}
          onClick={() => onReject(proposal)}
        >
          <CloseIcon size={13} />
          拒绝
        </button>
        <button
          type="button"
          className="btn btn-discuss"
          data-testid="btn-discuss"
          disabled={!actionable || busy}
          aria-expanded={discussOpen}
          onClick={() => setDiscussOpen((open) => !open)}
        >
          继续讨论
        </button>
        <button
          type="button"
          className="btn btn-locate"
          data-testid="btn-locate"
          onClick={() => onLocate(proposal)}
          title="在正文中定位该段落"
        >
          <LocateIcon size={13} />
          定位
        </button>
      </footer>

      {locateNotice ? (
        <p className="proposal-locate-note" data-testid="proposal-locate-note">
          <AlertIcon size={12} />
          {locateNotice}
        </p>
      ) : null}

      {discussOpen ? (
        <div className="discuss-box">
          <textarea
            className="discuss-input"
            data-testid="discuss-input"
            rows={2}
            value={discussText}
            placeholder="说明希望如何调整该条建议（只更新这一条，不影响其它建议）"
            onChange={(event) => setDiscussText(event.target.value)}
          />
          <div className="discuss-actions">
            <span className="discuss-hint">继续讨论只更新本条建议，不修改文档。</span>
            <button
              type="button"
              className="btn btn-primary btn-tiny"
              data-testid="btn-discuss-send"
              disabled={busy || discussText.trim().length === 0}
              onClick={() => {
                const message = discussText.trim();
                if (!message) return;
                onDiscuss(proposal, message);
                setDiscussText('');
                setDiscussOpen(false);
              }}
            >
              发送讨论
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
