/** 轻量 Toast 通知（错误/成功/提示），自动消失，不阻塞工作区。 */
import type { ToastItem } from '../ui/types';
import { AlertIcon, CheckIcon, CloseIcon } from './Icons';

interface ToastsProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" data-testid="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} data-testid="toast" data-kind={toast.kind}>
          <span className="toast-icon">
            {toast.kind === 'error' ? <AlertIcon size={15} /> : <CheckIcon size={15} />}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭通知"
            onClick={() => onDismiss(toast.id)}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
