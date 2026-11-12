/**
 * DSHExecutionBackend（默认路径）：本机 P0 形态的“最小受控执行器”。
 *
 * - 服务端直接调用已配置的 OpenAI 兼容网关（或可选官方 Anthropic 兼容端点）完成生成/讨论；
 * - **不调用开发机 shell，不冒充 Codex 终端能力**；
 * - 只读阶段（生成/讨论）允许 schema 修复重试；不跨 provider 自动上传同一批材料。
 */
import type { AppConfig } from '../config.js';
import { createLlmRouter } from '../llm/router.js';
import { LlmError } from '../llm/types.js';
import type { LlmRouter } from '../llm/router.js';
import { runDiscussionWithProvider, runGenerationWithProvider } from './pipeline.js';
import type {
  BackendCapabilities,
  ExecutionBackend,
  ExecutionContext,
  ExecutionResult,
  ExecutionTask,
} from './types.js';

export interface DshBackendOptions {
  router?: LlmRouter;
}

export function createDshBackend(cfg: AppConfig, options: DshBackendOptions = {}): ExecutionBackend {
  const router = options.router ?? createLlmRouter(cfg);

  function capabilities(): BackendCapabilities {
    if (cfg.mockOnly) {
      return {
        id: 'dsh',
        label: 'DSH（真实模型网关）',
        available: false,
        mock: false,
        reason: '当前为模拟模式（YXWORKER_MOCK_ONLY=1），已强制使用 Mock 执行器。',
      };
    }
    const provider = router.defaultProvider();
    if (!provider.configured) {
      return {
        id: 'dsh',
        label: 'DSH（真实模型网关）',
        available: false,
        mock: false,
        reason: '未配置模型网关凭据（仅可使用模拟执行器）。',
      };
    }
    return {
      id: 'dsh',
      label: 'DSH（真实模型网关）',
      available: true,
      mock: false,
      reason: `服务端直连 ${provider.label}，不调用开发机 shell；结构化输出由服务端校验。`,
    };
  }

  return {
    id: 'dsh',
    capabilities,
    async start(task: ExecutionTask, ctx: ExecutionContext): Promise<ExecutionResult> {
      const current = capabilities();
      if (!current.available) {
        throw new LlmError('backend_unavailable', current.reason, { retryable: false });
      }
      const provider = router.defaultProvider();
      if (!provider.configured) {
        throw new LlmError('credential_missing', '所选提供方未配置凭据，无法调用真实模型', {
          retryable: false,
        });
      }
      const model = router.modelFor(provider.id, task.tier);
      return task.type === 'proposal_generation'
        ? runGenerationWithProvider(provider, model, task, ctx)
        : runDiscussionWithProvider(provider, model, task, ctx);
    },
    cancel(): boolean {
      // 真实 fetch 通过 service 层的 AbortController 取消；此处无独立状态。
      return false;
    },
    resume(): boolean {
      return false;
    },
  };
}
