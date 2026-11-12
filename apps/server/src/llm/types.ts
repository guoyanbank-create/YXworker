/**
 * LLM Provider 抽象（PRODUCT_SPEC §3.2）：
 * - 与 Agent Runtime/ExecutionBackend 严格分离，一个 provider 只是“文本/结构化 JSON 提供方”。
 * - 密钥、baseUrl、模型 ID 只存在于服务端 config 内存中，本层绝不记录/返回凭据。
 * - 网关只保证 `json_object` 可用：结构化输出由服务端 zod 校验 + 一次修复重试兜底。
 */
import type { Citation, ParagraphBlock } from '../types.js';
import type { TierName } from '../config.js';

export type LlmProviderId = 'openai-compatible' | 'deepseek-anthropic' | 'mock';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 引用材料（服务端内存结构；content 只在发送给模型时截断使用，不写入 Run/日志）。 */
export interface ReferenceMaterial {
  id: string;
  title: string;
  content: string;
  /** 可由引用正文推导出的可见小节定位符。 */
  locators: string[];
}

/** 结构化任务上下文：prompt 用于构造消息；mock provider 用它确定性地产出结果。 */
export type StructuredTaskContext =
  | {
      task: 'generation';
      /** 目标章节序号（从 0 开始）；null 表示不限定章节。 */
      chapterIndex: number | null;
      chapterTitle: string | null;
      /** 候选段落块（目标章节正文 + 标题）。 */
      blocks: ParagraphBlock[];
      count: number;
      references: ReferenceMaterial[];
    }
  | {
      task: 'discussion';
      proposal: { oldText: string; newText: string; reason: string };
      message: string;
      references: ReferenceMaterial[];
    };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LlmCallRequest {
  messages: LlmMessage[];
  /** 实际请求的模型 ID（由 tier 映射而来）。 */
  model: string;
  responseFormat: 'json_object' | 'text';
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
  /** 仅 mock provider 需要的结构化上下文；真实 provider 忽略。 */
  context?: StructuredTaskContext;
  /** 测试注入用；生产环境使用 globalThis.fetch。 */
  fetchImpl?: FetchLike;
  /** 运行取消信号。 */
  signal?: AbortSignal;
}

export interface LlmCallResult {
  rawText: string;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
}

export interface LlmProvider {
  id: LlmProviderId;
  label: string;
  /** 模拟提供方：结果必须在 UI/运行记录上标注“模拟”。 */
  mock: boolean;
  configured: boolean;
  models: string[];
  generate(request: LlmCallRequest): Promise<LlmCallResult>;
}

/** 与 API_CONTRACT 错误码一致。 */
export type LlmErrorCode =
  | 'credential_missing'
  | 'data_policy_blocked'
  | 'model_rate_limited'
  | 'model_unavailable'
  | 'model_timeout'
  | 'model_schema_invalid'
  | 'backend_unavailable'
  | 'fault_injected';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  /** 建议的 HTTP 状态码（用于路由层即时失败；异步 Run 只记录 code）。 */
  readonly httpStatus: number;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
  }
}

export function defaultHttpStatus(code: LlmErrorCode): number {
  switch (code) {
    case 'credential_missing':
      return 400;
    case 'backend_unavailable':
      return 400;
    case 'data_policy_blocked':
      return 403;
    case 'model_rate_limited':
      return 429;
    case 'model_unavailable':
      return 502;
    case 'model_timeout':
      return 504;
    case 'model_schema_invalid':
      return 502;
    case 'fault_injected':
      return 500;
    default:
      return 500;
  }
}

/** Run 记录所需的错误体（不含密钥/正文）。 */
export interface RunErrorLike {
  code: string;
  message: string;
  retryable: boolean;
}

export function toRunError(error: unknown): RunErrorLike {
  if (error instanceof LlmError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'model_unavailable',
    // 兜底消息只保留简短摘要，避免把上游响应/URL/正文写进数据库。
    message: `执行器内部错误：${message.slice(0, 200)}`,
    retryable: false,
  };
}

/** 生成结果中的单条提案（服务端校验后、落库前的结构）。 */
export interface ProposalDraft {
  paragraphId: string;
  oldText: string;
  newText: string;
  reason: string;
  citations: Citation[];
}

/** 规范化后的生成结果（带目标段落派生信息）。 */
export interface NormalizedProposalDraft extends ProposalDraft {
  paragraphIndex: number;
  chapterTitle: string;
  quote: string;
}

export interface GenerationOutput {
  proposals: NormalizedProposalDraft[];
  notes: string[];
}

export interface DiscussionOutput {
  newText: string;
  reason: string;
}

export interface ProposalGenerationRequest {
  prompt: string;
  tier: TierName;
  backend: 'dsh' | 'mock';
  count: number;
  fault?: string;
}

export interface ProposalDiscussionRequest {
  message: string;
  tier: TierName;
  backend: 'dsh' | 'mock';
  fault?: string;
}
