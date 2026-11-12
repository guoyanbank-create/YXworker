/**
 * DeepSeek 官方 Anthropic 兼容端点 provider（可选路径）。
 * 仅当 `YXWORKER_LLM_PROVIDER=deepseek-anthropic` 或网关未配置而官方端点已配置时使用。
 * 该端点不支持 json_schema/response_format：结构化输出同样由服务端 zod 校验 + 一次修复重试。
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
import { DEFAULT_MODEL_TIMEOUT_MS } from './openaiCompatibleProvider.js';

export interface DeepseekAnthropicProviderOptions {
  config: { apiKey: string; anthropicBaseUrl: string; model: string };
  /** 长思考档位模型（来自 config.llm.modelPro）。 */
  longReasoningModel?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  label?: string;
}

export function deepseekModelForTier(
  options: Pick<DeepseekAnthropicProviderOptions, 'config' | 'longReasoningModel'>,
  tier: TierName,
): string {
  if (tier === 'long_reasoning') {
    const pro = options.longReasoningModel?.trim();
    if (pro) return pro;
  }
  return options.config.model;
}

export function createDeepseekAnthropicProvider(
  options: DeepseekAnthropicProviderOptions,
): LlmProvider {
  const providerConfig = options.config;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;

  return {
    id: 'deepseek-anthropic',
    label: options.label ?? 'DeepSeek 官方端点（Anthropic 兼容）',
    mock: false,
    configured: Boolean(providerConfig.anthropicBaseUrl && providerConfig.apiKey),
    models: [providerConfig.model, options.longReasoningModel ?? ''].filter((item) => item.length > 0),
    async generate(request: LlmCallRequest): Promise<LlmCallResult> {
      if (!providerConfig.apiKey || !providerConfig.anthropicBaseUrl) {
        throw new LlmError('credential_missing', '未配置 DeepSeek 官方端点凭据（服务端 apiKey/baseUrl）', {
          retryable: false,
        });
      }
      const url = joinUrl(providerConfig.anthropicBaseUrl, '/v1/messages');
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      const conversation = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content }));
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: typeof request.maxTokens === 'number' ? request.maxTokens : 4096,
        temperature: request.temperature ?? 0.2,
        messages: conversation,
      };
      if (system.length > 0) body.system = system;

      const started = Date.now();
      let response: Response;
      try {
        response = await resolveFetch(options.fetchImpl ?? request.fetchImpl)(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': providerConfig.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: buildSignal(request.timeoutMs ?? timeoutMs, request.signal),
        });
      } catch (error) {
        throw mapFetchError(error);
      }
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        await response.text().catch(() => '');
        throw mapHttpStatus(response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new LlmError('model_unavailable', '模型端点响应不是合法 JSON', { retryable: true });
      }
      const data = asRecord(payload);
      const blocks = Array.isArray(data?.content) ? (data.content as unknown[]) : null;
      if (!blocks) {
        throw new LlmError('model_unavailable', '模型端点响应缺少 content', { retryable: true });
      }
      const rawText = blocks
        .map((block) => asRecord(block))
        .filter((block): block is Record<string, unknown> => Boolean(block))
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('');
      const usage = asRecord(data?.usage);
      return {
        rawText,
        model: typeof data?.model === 'string' && data.model.length > 0 ? data.model : request.model,
        latencyMs,
        tokensIn: numberOrZero(usage?.input_tokens),
        tokensOut: numberOrZero(usage?.output_tokens),
        finishReason: typeof data?.stop_reason === 'string' ? data.stop_reason : null,
      };
    },
  };
}

export type { LlmProviderConfig };
