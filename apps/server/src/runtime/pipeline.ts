/**
 * 执行器共用流水线：构造提示词 → provider 调用（结构化 JSON）→ zod + 业务校验 → 一次修复重试。
 * 真实 provider 与 mock provider 共用同一流水线，保证 mock 输出也走完整校验。
 */
import { DEFAULT_MODEL_TIMEOUT_MS } from '../llm/openaiCompatibleProvider.js';
import { buildDiscussionMessages, buildGenerationMessages } from '../llm/prompt.js';
import {
  discussionOutputSchema,
  generationOutputSchema,
  normalizeDiscussionOutput,
  normalizeGenerationOutput,
  type NormalizedGenerationResult,
} from '../llm/schema.js';
import { callStructured } from '../llm/structured.js';
import { LlmError } from '../llm/types.js';
import type { DiscussionOutput, LlmProvider } from '../llm/types.js';
import type {
  DiscussionTask,
  ExecutionContext,
  ExecutionResult,
  GenerationTask,
} from './types.js';

/**
 * 真实模型调用超时：默认 60s；可用 YXWORKER_LLM_TIMEOUT_MS 调整（缺陷修复要求：超时必须映射到 run，不得悬挂）
 * （仅只读阶段；不改变 429/5xx/网络/超时分别映射错误码的行为）。
 */
function modelTimeoutMs(): number {
  const raw = Number(process.env.YXWORKER_LLM_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MODEL_TIMEOUT_MS;
}

export async function runGenerationWithProvider(
  provider: LlmProvider,
  model: string,
  task: GenerationTask,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const messages = buildGenerationMessages({
    projectName: task.projectName,
    documentTitle: task.documentTitle,
    userPrompt: task.prompt,
    blocks: task.blocks,
    targetChapterIndex: task.targetChapterIndex,
    chapterTitle: task.chapterTitle,
    references: task.references,
    count: task.count,
  });

  ctx.emit('info', `调用模型提供方 ${provider.id}（model=${model}）`, {
    provider: provider.id,
    model,
    tier: task.tier,
    mock: provider.mock,
  });

  let normalized: NormalizedGenerationResult | null = null;
  const result = await callStructured({
    provider,
    request: {
      messages,
      model,
      responseFormat: 'json_object',
      timeoutMs: modelTimeoutMs(),
      temperature: 0.2,
      context: {
        task: 'generation',
        chapterIndex: task.targetChapterIndex,
        chapterTitle: task.chapterTitle,
        blocks: task.blocks,
        count: task.count,
        references: task.references,
      },
    },
    schema: generationOutputSchema,
    validate: (payload) => {
      normalized = normalizeGenerationOutput(payload, {
        blocks: task.blocks,
        references: task.references,
        targetChapterIndex: task.targetChapterIndex,
        count: task.count,
      });
    },
    onRepair: ({ attempt, reason }) => {
      // reason 只包含 paragraphId/结构错误，不含文档全文或密钥。
      ctx.emit('warn', `模型输出不合法，进行第 ${attempt} 次修复重试`, { reason });
    },
  });

  if (!normalized) {
    throw new LlmError('model_schema_invalid', '生成结果未通过服务端校验', { retryable: false });
  }
  const output = normalized as NormalizedGenerationResult;
  ctx.emit('info', `生成 ${output.proposals.length} 条提案，已通过服务端 Schema 与段落校验`, {
    proposals: output.proposals.length,
    repaired: result.repaired,
    notes: output.notes,
  });

  return {
    provider: provider.id,
    model: result.model,
    latencyMs: result.latencyMs,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    retryReason: result.retryReason,
    generation: { proposals: output.proposals, notes: output.notes },
  };
}

export async function runDiscussionWithProvider(
  provider: LlmProvider,
  model: string,
  task: DiscussionTask,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const messages = buildDiscussionMessages({
    projectName: task.projectName,
    documentTitle: task.documentTitle,
    proposal: { ...task.proposal },
    message: task.message,
    references: task.references,
  });

  ctx.emit('info', `调用模型提供方 ${provider.id}（model=${model}，讨论）`, {
    provider: provider.id,
    model,
    tier: task.tier,
    mock: provider.mock,
  });

  let discussion: DiscussionOutput | null = null;
  const result = await callStructured({
    provider,
    request: {
      messages,
      model,
      responseFormat: 'json_object',
      timeoutMs: modelTimeoutMs(),
      temperature: 0.2,
      context: {
        task: 'discussion',
        proposal: {
          oldText: task.proposal.oldText,
          newText: task.proposal.newText,
          reason: task.proposal.reason,
        },
        message: task.message,
        references: task.references,
      },
    },
    schema: discussionOutputSchema,
    validate: (payload) => {
      discussion = normalizeDiscussionOutput(payload);
    },
    onRepair: ({ attempt, reason }) => {
      ctx.emit('warn', `讨论输出不合法，进行第 ${attempt} 次修复重试`, { reason });
    },
  });

  if (!discussion) {
    throw new LlmError('model_schema_invalid', '讨论结果未通过服务端校验', { retryable: false });
  }
  const output = discussion as DiscussionOutput;
  ctx.emit('info', '讨论结果已通过服务端校验（仅更新该条提案，不修改文档）', {
    repaired: result.repaired,
  });

  return {
    provider: provider.id,
    model: result.model,
    latencyMs: result.latencyMs,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    retryReason: result.retryReason,
    discussion: output,
  };
}
