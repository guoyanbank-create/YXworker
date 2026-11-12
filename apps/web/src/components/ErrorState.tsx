/** 首屏致命错误态：后端不可用时给出可读原因与恢复指引（绝不白屏）。 */
import { errorHint } from '../api/client';
import { AlertIcon, RefreshIcon } from './Icons';

interface ErrorStateProps {
  message: string;
  code?: string | null;
  onRetry: () => void;
  retrying: boolean;
}

export function ErrorState({ message, code, onRetry, retrying }: ErrorStateProps) {
  const hint =
    errorHint(code ?? null) ??
    '请确认本机后端已启动：pnpm dev:server（监听 127.0.0.1:8787），首次运行会自动写入演示数据。';
  return (
    <div className="fatal-error" data-testid="fatal-error">
      <div className="fatal-error-card">
        <div className="fatal-error-icon">
          <AlertIcon size={22} />
        </div>
        <h2>无法加载工作台</h2>
        <p className="fatal-error-message">{message}</p>
        {code ? (
          <pre className="fatal-error-detail" data-testid="fatal-error-detail">
            {`error.code = ${code}`}
          </pre>
        ) : null}
        <p className="fatal-error-hint">{hint}</p>
        <div className="fatal-error-actions">
          <button type="button" className="btn btn-primary" data-testid="btn-retry" onClick={onRetry} disabled={retrying}>
            <RefreshIcon size={15} />
            {retrying ? '正在重试…' : '重试连接'}
          </button>
          <span className="fatal-error-meta">仅本机访问 · 127.0.0.1:8787</span>
        </div>
      </div>
    </div>
  );
}
