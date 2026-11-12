/** 展示层格式化工具（时间/耗时/文本/后端标签）。 */
import type { RunStatus } from '../api/types';

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatTokens(tokensIn: number, tokensOut: number): string {
  if (!tokensIn && !tokensOut) return '—';
  return `${tokensIn} / ${tokensOut}`;
}

export function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return String(value);
}

export function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function backendLabel(backend: string | null | undefined): string {
  switch (backend) {
    case 'dsh':
      return 'DSH（真实模型）';
    case 'mock':
      return '模拟';
    case 'codex':
      return 'Codex';
    default:
      return backend ?? '未知';
  }
}

export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '运行中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}

export function runTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'proposal_generation':
      return '生成建议';
    case 'discussion':
      return '继续讨论';
    default:
      return type ?? '运行';
  }
}

export function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
