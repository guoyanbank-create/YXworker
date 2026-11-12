/**
 * 结构化输出流水线：provider 调用 → 提取 JSON → zod 校验 → 业务规则校验 → 一次修复重试。
 * 真实 provider 与 mock provider 走完全相同的校验路径（mock 不是“绕过校验”的捷径）。
 */
import type { z } from 'zod';
import {
  buildRepairMessages,
  extractJsonObject,
  formatZodIssues,
  SchemaRepairError,
} from './schema.js';
import { LlmError } from './types.js';
import type { LlmCallRequest, LlmProvider } from './types.js';

export interface StructuredCallOptions<T> {
  provider: LlmProvider;
  request: LlmCallRequest;
  schema: z.ZodType<T>;
  /** 业务规则校验：抛 SchemaRepairError 触发修复重试。 */
  validate?: (value: T) => void;
  /** 修复重试次数（契约要求“一次修复重试”，默认 1）。 */
  maxRepairAttempts?: number;
  /** 修复发生时写入 Run 事件（不包含模型全文/密钥）。 */
  onRepair?: (info: { attempt: number; reason: string }) => void;
}

export interface StructuredCallResult<T> {
  value: T;
  repaired: boolean;
  retryReason: string | null;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
}

export async function callStructured<T>(
  options: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
  const maxRepairs = Math.max(0, options.maxRepairAttempts ?? 1);
  let messages = options.request.messages;
  let latencyMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let model = options.request.model;
  let finishReason: string | null = null;
  let lastError = '';

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const result = await options.provider.generate({ ...options.request, messages });
    latencyMs += result.latencyMs;
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
    if (result.model) model = result.model;
    finishReason = result.finishReason;

    try {
      const parsed = extractJsonObject(result.rawText);
      if (parsed === null) {
        throw new SchemaRepairError('模型输出不是合法 JSON 对象');
      }
      const validated = options.schema.safeParse(parsed);
      if (!validated.success) {
        throw new SchemaRepairError(`Schema 校验失败：${formatZodIssues(validated.error)}`);
      }
      options.validate?.(validated.data);
      return {
        value: validated.data,
        repaired: attempt > 0,
        retryReason: attempt > 0 ? 'schema_repair' : null,
        model,
        latencyMs,
        tokensIn,
        tokensOut,
        finishReason,
      };
    } catch (error) {
      const reason =
        error instanceof SchemaRepairError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      lastError = reason;
      if (attempt < maxRepairs) {
        options.onRepair?.({ attempt: attempt + 1, reason });
        messages = buildRepairMessages(options.request.messages, result.rawText, reason);
        continue;
      }
    }
  }

  throw new LlmError(
    'model_schema_invalid',
    `模型输出经一次修复重试后仍不符合 Schema：${lastError.slice(0, 300)}`,
    { retryable: false },
  );
}
