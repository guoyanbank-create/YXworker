/** 运行过程面板：当前运行状态、事件流、错误分流、历史运行列表、取消运行。 */
import type { Run } from '../api/types';
import { isRunActive } from '../api/client';
import type { ApiErrorInfo, RunKind } from '../ui/types';
import { backendLabel, formatLatency, formatTime, formatTokens, runStatusLabel, runTypeLabel, shortId, truncate } from '../utils/format';
import { AlertIcon, RefreshIcon, SimulatedIcon, StopIcon } from './Icons';

export interface RunPanelProps {
  activeRun: Run | null;
  activeKind: RunKind | null;
  recentRuns: Run[];
  runError: ApiErrorInfo | null;
  runBusy: boolean;
  onCancelRun: () => void;
  onSelectRun: (run: Run) => void;
  onRefreshRuns: () => void;
}

function statusTone(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'ok';
    case 'failed':
      return 'danger';
    case 'cancelled':
      return 'muted';
    case 'running':
    case 'queued':
      return 'active';
    default:
      return 'muted';
  }
}

function RunErrorBlock({ error }: { error: ApiErrorInfo }) {
  return (
    <div className="run-error-block" data-testid="run-error" data-code={error.code}>
      <div className="run-error-head">
        <AlertIcon size={14} />
        <span className="run-error-code">{error.code}</span>
        <span className="run-error-time">{formatTime(error.at)}</span>
      </div>
      <p className="run-error-message">{error.message}</p>
      {error.hint ? <p className="run-error-hint">{error.hint}</p> : null}
    </div>
  );
}

export function RunPanel({
  activeRun,
  activeKind,
  recentRuns,
  runError,
  runBusy,
  onCancelRun,
  onSelectRun,
  onRefreshRuns,
}: RunPanelProps) {
  const run = activeRun;
  const running = isRunActive(run) || runBusy;
  const kindLabel =
    activeKind === 'fault'
      ? '故障演练'
      : activeKind === 'discuss'
        ? '继续讨论'
        : run
          ? runTypeLabel(run.type)
          : '生成建议';

  return (
    <section className="panel-section run-panel" data-testid="run-panel">
      <div className="section-head">
        <h3>
          运行过程
          {run ? <span className="section-sub">{kindLabel}</span> : null}
        </h3>
        <div className="section-actions">
          {running && run ? (
            <button type="button" className="btn btn-danger btn-xs" data-testid="btn-cancel-run" onClick={onCancelRun}>
              <StopIcon size={12} />
              取消
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            title="刷新运行记录"
            aria-label="刷新运行记录"
            data-testid="btn-refresh-runs"
            onClick={onRefreshRuns}
          >
            <RefreshIcon size={14} />
          </button>
        </div>
      </div>

      {run ? (
        <div className="run-card" data-testid="run-status" data-status={run.status}>
          <div className="run-card-head">
            <span className={`pill status-${statusTone(run.status)}`} data-testid="run-status-label">
              {run.status === 'running' || run.status === 'queued' ? <span className="spinner spinner-sm" /> : null}
              {runStatusLabel(run.status)}
            </span>
            <span className={`pill ${run.backend === 'mock' ? 'pill-mock' : 'pill-real'}`}>
              {run.backend === 'mock' ? <SimulatedIcon size={11} /> : null}
              {backendLabel(run.backend)}
            </span>
            <span className="run-id" title={run.id}>
              {shortId(run.id)}
            </span>
          </div>

          <dl className="run-meta">
            <div>
              <dt>模型</dt>
              <dd title={run.model}>{run.model || '—'}</dd>
            </div>
            <div>
              <dt>档位</dt>
              <dd>{run.tier || '—'}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{formatLatency(run.latencyMs)}</dd>
            </div>
            <div>
              <dt>Token（入/出）</dt>
              <dd>{formatTokens(run.tokensIn, run.tokensOut)}</dd>
            </div>
          </dl>

          {run.retryReason ? <p className="run-note">重试原因：{run.retryReason}</p> : null}
          {run.fallbackFrom ? <p className="run-note">降级来源：{run.fallbackFrom}</p> : null}

          {run.error && (!runError || runError.code !== run.error.code) ? (
            <RunErrorBlock
              error={{
                code: run.error.code,
                message: run.error.message,
                hint: run.error.retryable ? '该错误可重试。' : null,
                at: run.updatedAt,
              }}
            />
          ) : null}

          {run.events.length > 0 ? (
            <ol className="run-events" data-testid="run-events">
              {run.events.map((event) => (
                <li key={event.seq} className={`run-event level-${event.level}`}>
                  <span className="run-event-seq">{event.seq}</span>
                  <span className="run-event-time">{formatTime(event.at)}</span>
                  <span className="run-event-message">{event.message}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="run-empty-events">等待执行器事件…</p>
          )}

          <p className="run-prompt" title={run.prompt}>
            提示词：{truncate(run.prompt, 80)}
          </p>
        </div>
      ) : (
        <p className="section-empty">尚无运行记录。在左侧输入对话并生成建议后，这里会显示执行器事件与错误。</p>
      )}

      {runError ? <RunErrorBlock error={runError} /> : null}

      {recentRuns.length > 0 ? (
        <div className="run-history">
          <h4>最近运行</h4>
          <ul className="run-list" data-testid="run-list">
            {recentRuns.slice(0, 8).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`run-list-item${run?.id === item.id ? ' is-active' : ''}`}
                  data-testid="run-item"
                  onClick={() => onSelectRun(item)}
                  title={`${runTypeLabel(item.type)} · ${item.id}`}
                >
                  <span className={`run-list-dot status-${statusTone(item.status)}`} />
                  <span className="run-list-type">{runTypeLabel(item.type)}</span>
                  <span className="run-list-backend">
                    {item.backend === 'mock' ? '模拟' : backendLabel(item.backend)}
                  </span>
                  <span className="run-list-time">{formatTime(item.createdAt)}</span>
                  <span className={`run-list-status status-${statusTone(item.status)}`}>
                    {runStatusLabel(item.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
