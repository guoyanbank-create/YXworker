/** 真实 provider 共用的 HTTP 细节：URL 拼接、超时信号、错误码映射（不打印/不回传响应正文）。 */
import { LlmError, type FetchLike } from './types.js';

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** 合并（可选）外部取消信号与超时信号。 */
export function buildSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!external) return timeout;
  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anySignal === 'function') return anySignal([external, timeout]);
  // 兜底：无 AbortSignal.any 时仅使用超时信号（取消会在事件边界检查）。
  return timeout;
}

/** HTTP 状态 → 契约错误码。响应正文不进入错误消息（避免泄漏上游细节）。 */
export function mapHttpStatus(status: number): LlmError {
  if (status === 429) {
    return new LlmError('model_rate_limited', '模型网关返回 429（触发限流），请稍后重试', {
      retryable: true,
      httpStatus: 429,
    });
  }
  if (status === 401 || status === 403) {
    return new LlmError('credential_missing', '模型网关鉴权失败：请检查服务端凭据配置', {
      retryable: false,
    });
  }
  if (status === 408) {
    return new LlmError('model_timeout', '模型网关请求超时', { retryable: true });
  }
  if (status >= 500) {
    return new LlmError('model_unavailable', `模型网关返回 ${status}，暂不可用`, { retryable: true });
  }
  return new LlmError('model_unavailable', `模型网关请求失败（HTTP ${status}）`, { retryable: false });
}

/** fetch 抛错 → 超时/网络错误码。 */
export function mapFetchError(error: unknown): LlmError {
  const name = error instanceof Error ? error.name : '';
  const causeCode =
    error && typeof error === 'object' && 'cause' in error
      ? ((error as { cause?: { code?: unknown } }).cause?.code as string | undefined)
      : undefined;
  const timeoutCodes = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'ETIMEDOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]);
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    (causeCode !== undefined && timeoutCodes.has(causeCode))
  ) {
    return new LlmError('model_timeout', '模型网关请求超时（默认 90s）', { retryable: true });
  }
  return new LlmError('model_unavailable', '模型网关网络请求失败（网络中断或地址不可达）', {
    retryable: true,
  });
}

export function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  return (input, init) => globalThis.fetch(input, init);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
