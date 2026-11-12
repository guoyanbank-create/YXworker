/**
 * ExecutionBackend 抽象（PRODUCT_SPEC §3.1 / ARCHITECTURE §4）。
 *
 * 与 LLM Provider 分离：ExecutionBackend 负责任务编排（生成/讨论的完整流水线），
 * LLM Provider 只负责一次模型调用。P0 的 DSH 是“最小受控执行器”：服务端直接调用已配置的
 * OpenAI 兼容网关，**不调用开发机 shell、不冒充 Codex 终端能力**。
 */
import type { TierName } from '../config.js';
import type { ParagraphBlock } from '../types.js';
import type {
  DiscussionOutput,
  GenerationOutput,
  ReferenceMaterial,
} from '../llm/types.js';

export type RuntimeBackendId = 'dsh' | 'mock' | 'codex';
export type RunEventLevel = 'info' | 'warn' | 'error';

export interface BackendCapabilities {
  id: RuntimeBackendId;
  label: string;
  available: boolean;
  /** 是否为模拟执行器（结果必须在 UI 明确标注“模拟”）。 */
  mock: boolean;
  reason: string;
}

export interface GenerationTask {
  type: 'proposal_generation';
  projectName: string;
  documentTitle: string;
  /** 生成开始时的文档 revision（写入提案 baseRevision）。 */
  documentRevision: number;
  prompt: string;
  count: number;
  tier: TierName;
  /** 目标章节（0 起）；null 表示不限定（真实模型由提示词自行判断）。 */
  targetChapterIndex: number | null;
  chapterTitle: string | null;
  /** 文档全部派生段落块（服务端权威）。 */
  blocks: ParagraphBlock[];
  references: ReferenceMaterial[];
}

export interface DiscussionTask {
  type: 'discussion';
  projectName: string;
  documentTitle: string;
  proposal: { paragraphId: string; oldText: string; newText: string; reason: string };
  message: string;
  tier: TierName;
  references: ReferenceMaterial[];
}

export type ExecutionTask = GenerationTask | DiscussionTask;

export interface ExecutionContext {
  runId: string;
  signal: AbortSignal;
  /** 写入 Run 事件流（前端轮询展示过程）。 */
  emit(level: RunEventLevel, message: string, data?: unknown): void;
}

export interface ExecutionResult {
  provider: string;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  retryReason: string | null;
  generation?: GenerationOutput;
  discussion?: DiscussionOutput;
}

export interface ExecutionBackend {
  id: RuntimeBackendId;
  capabilities(): BackendCapabilities;
  /** 启动并等待任务完成；执行过程通过 ctx.emit 记录事件。 */
  start(task: ExecutionTask, ctx: ExecutionContext): Promise<ExecutionResult>;
  /** 尽力取消；真实 fetch 会在下一事件边界/信号处响应。 */
  cancel(runId: string): boolean;
  /** P0 不支持恢复执行。 */
  resume(runId: string): boolean;
}
