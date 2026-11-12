/**
 * OpenAI 兼容网关 provider（默认路径）。
 * - `response_format: { type: "json_object" }`：网关实测支持 json_object、不支持 json_schema。
 * - 只发 Chat Completions；不打印请求体/响应体/密钥。
 * - 429/5xx/网络/超时映射为契约错误码（API_CONTRACT §0）。
 */
import type { LlmProviderConfig, TierName } from '../config.js';
import {
  asRecord,
  buildSignal,
  joinUrl,
  mapFetchError,
  mapHttpStatus,
  numberOrZero,
  resolveFetch,
} from './http.js';
import { LlmError } from './types.js';
import type { FetchLike, LlmCallRequest, LlmCallResult, LlmProvider } from './types.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 90_000;

export interface OpenAiCompatibleProviderOptions {
  /** 只传 config.llm（含 baseUrl/apiKey/model/tiers），凭据仅存在于服务端内存。 */
  config: LlmProviderConfig;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  label?: string;
}

function isConfigured(config: LlmProviderConfig): boolean {
  return Boolean(config.baseUrl && config.apiKey);
}

export function modelForTier(config: LlmProviderConfig, tier: TierName): string {
  return tier === 'long_reasoning' ? config.tiers.long_reasoning : config.tiers.review;
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleProviderOptions,
): LlmProvider {
  const providerConfig = options.config;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;

  return {
    id: 'openai-compatible',
    label: options.label ?? 'OpenAI 兼容网关',
    mock: false,
    configured: isConfigured(providerConfig),
    models: [providerConfig.model, providerConfig.modelPro].filter((item) => item.length > 0),
    async generate(request: LlmCallRequest): Promise<LlmCallResult> {
      if (!isConfigured(providerConfig)) {
        throw new LlmError('credential_missing', '未配置 OpenAI 兼容网关凭据（服务端 baseUrl/apiKey）', {
          retryable: false,
        });
      }
      const url = joinUrl(providerConfig.baseUrl, '/chat/completions');
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        stream: false,
      };
      if (request.responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
      if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens;

      const started = Date.now();
      let response: Response;
      try {
        response = await resolveFetch(options.fetchImpl ?? request.fetchImpl)(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${providerConfig.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: buildSignal(request.timeoutMs ?? timeoutMs, request.signal),
        });
      } catch (error) {
        throw mapFetchError(error);
      }
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        // 只丢弃响应体，不记录（上游错误可能包含请求上下文）。
        await response.text().catch(() => '');
        throw mapHttpStatus(response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new LlmError('model_unavailable', '模型网关响应不是合法 JSON', { retryable: true });
      }
      const data = asRecord(payload);
      const choices = Array.isArray(data?.choices) ? (data.choices as unknown[]) : [];
      const choice = asRecord(choices[0]);
      if (!choice) {
        throw new LlmError('model_unavailable', '模型网关响应缺少 choices', { retryable: true });
      }
      const message = asRecord(choice.message);
      const rawText = typeof message?.content === 'string' ? message.content : '';
      const usage = asRecord(data?.usage);
      return {
        rawText,
        model: typeof data?.model === 'string' && data.model.length > 0 ? data.model : request.model,
        latencyMs,
        tokensIn: numberOrZero(usage?.prompt_tokens),
        tokensOut: numberOrZero(usage?.completion_tokens),
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      };
    },
  };
}
