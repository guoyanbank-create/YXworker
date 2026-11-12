/** 执行器注册表：装配 DSH（默认）/ Mock / Codex（仅探测），供路由与状态接口使用。 */
import type { AppConfig, TierName } from '../config.js';
import { LlmError } from '../llm/types.js';
import type { LlmProvider } from '../llm/types.js';
import { createLlmRouter, providerKindOf } from '../llm/router.js';
import type { LlmRouter, ProviderKind } from '../llm/router.js';
import type { BackendStatus } from '../types.js';
import { createCodexBackend } from './codexBackend.js';
import { createDshBackend } from './dshBackend.js';
import { createMockBackend } from './mockBackend.js';
import type { ExecutionBackend, RuntimeBackendId } from './types.js';

/**
 * 请求实际生效的执行器（P1 provider 三选时的归并规则）：
 * - 运行在模拟模式（YXWORKER_MOCK_ONLY=1）→ mock；
 * - `backend=mock` → mock（契约要求强制 mock provider）；
 * - 显式 `backend=dsh` 时保持 dsh（执行器/提供方严格分离：provider=mock 表示
 *   DSH 编排流水线调用离线 mock provider，Run/提案仍记录 provider=mock、model=mock-*、
 *   事件标注 mock=true，绝不冒充真实模型）；
 * - 其余 → dsh（真实模型网关，由所选 provider 提供模型）。
 */
export function effectiveBackendId(
  cfg: AppConfig,
  backend: string,
  _provider?: string,
): 'dsh' | 'mock' {
  if (cfg.mockOnly) return 'mock';
  if (backend === 'mock') return 'mock';
  return 'dsh';
}

/** 一次生成/讨论实际使用的执行器 + provider + 模型（创建 Run 前解析，写入 Run 记录）。 */
export interface ExecutionSelection {
  backendId: 'dsh' | 'mock';
  provider: LlmProvider;
  providerKind: ProviderKind;
  model: string;
  /** 请求被强制改写为 mock（backend=mock 强制 provider=mock，或 mockOnly）时为 true，用于事件与审计。 */
  forcedMock: boolean;
}

export interface SelectExecutionInput {
  backend: string;
  /** 请求选择的 provider（openai-compatible|deepseek-anthropic|mock）；不传用当前默认。 */
  provider?: string;
  tier: TierName;
}

export interface RuntimeRegistry {
  backends: ExecutionBackend[];
  llmRouter: LlmRouter;
  byId(id: string): ExecutionBackend | undefined;
  /** 状态接口展示顺序：dsh / mock / codex。 */
  statuses(): BackendStatus[];
  /** 生成/讨论请求选择的执行器；不可用时抛 LlmError（路由转 HTTP 错误）。 */
  assertSelectable(id: string): ExecutionBackend;
  /**
   * P1：解析生成/讨论请求的实际执行器与 provider。
   * 未配置凭据的真实 provider 抛 credential_missing；mock 归并规则见 effectiveBackendId。
   */
  selectExecution(input: SelectExecutionInput): ExecutionSelection;
  /**
   * 取得绑定到所选 provider 的执行器实例：
   * dsh 用该 provider 调用模型（不跨 provider 自动上传材料），mock 忽略 provider。
   */
  executionBackend(backendId: string, providerId?: string): ExecutionBackend;
}

export function createRuntimeRegistry(cfg: AppConfig): RuntimeRegistry {
  const llmRouter = createLlmRouter(cfg);
  const backends: ExecutionBackend[] = [
    createDshBackend(cfg, { router: llmRouter }),
    createMockBackend(),
    createCodexBackend(),
  ];

  function backendOrThrow(id: string): ExecutionBackend {
    const backend = backends.find((item) => item.id === id);
    if (!backend) {
      throw new LlmError('backend_unavailable', `执行器 ${id} 不存在`, { retryable: false });
    }
    return backend;
  }

  return {
    backends,
    llmRouter,
    byId(id: string): ExecutionBackend | undefined {
      return backends.find((backend) => backend.id === id);
    },
    statuses(): BackendStatus[] {
      return backends.map((backend) => {
        const capabilities = backend.capabilities();
        return {
          id: capabilities.id,
          label: capabilities.label,
          available: capabilities.available,
          mock: capabilities.mock,
          reason: capabilities.reason,
        };
      });
    },
    assertSelectable(id: string): ExecutionBackend {
      const backend = backends.find((item) => item.id === id);
      if (!backend) {
        throw new LlmError('backend_unavailable', `执行器 ${id} 不存在`, { retryable: false });
      }
      const capabilities = backend.capabilities();
      if (!capabilities.available) {
        if (id === 'dsh' && !llmRouter.realProviderConfigured()) {
          throw new LlmError(
            'credential_missing',
            '所选提供方未配置凭据：请配置服务端网关凭据，或改用模拟执行器。',
            { retryable: false },
          );
        }
        throw new LlmError('backend_unavailable', capabilities.reason, { retryable: false });
      }
      return backend;
    },
    selectExecution(input: SelectExecutionInput): ExecutionSelection {
      const backendId = effectiveBackendId(cfg, input.backend, input.provider);
      if (backendId === 'mock') {
        // backend=mock 强制 mock provider（契约）；请求未显式要求 mock 时记录“强制改写”。
        const forcedMock =
          input.backend !== 'mock' ||
          (input.provider !== undefined && input.provider !== 'mock');
        return {
          backendId,
          provider: llmRouter.mock,
          providerKind: 'mock',
          model: llmRouter.modelFor('mock', input.tier),
          forcedMock,
        };
      }
      // P0 语义：未显式选择 provider 时使用默认真实 provider（未配置 → credential_missing）。
      const provider = input.provider
        ? llmRouter.selectProvider(input.provider)
        : llmRouter.defaultProvider();
      if (!provider.configured) {
        throw new LlmError(
          'credential_missing',
          `所选提供方「${provider.label}」未配置凭据：请在服务端配置后重试，或改用模拟提供方。`,
          { retryable: false },
        );
      }
      return {
        backendId: 'dsh',
        provider,
        providerKind: providerKindOf(provider.id),
        model: llmRouter.modelFor(provider.id, input.tier),
        // provider=mock 是显式选择，不改写 backend；Run/提案以 provider/model + mock 事件标注。
        forcedMock: false,
      };
    },
    executionBackend(backendId: string, providerId?: string): ExecutionBackend {
      const backend = backendOrThrow(backendId);
      if (backendId === 'mock') return backend;
      if (backendId !== 'dsh') return backend;
      const provider = providerId
        ? llmRouter.selectProvider(providerId)
        : llmRouter.currentProvider();
      if (!provider.configured) {
        throw new LlmError(
          'credential_missing',
          `所选提供方「${provider.label}」未配置凭据，无法调用真实模型。`,
          { retryable: false },
        );
      }
      // 把所选 provider 绑定为执行器的默认 provider（DSH 执行器仍走同一套校验流水线）。
      const boundRouter: LlmRouter = { ...llmRouter, defaultProvider: () => provider };
      return createDshBackend(cfg, { router: boundRouter });
    },
  };
}

export type { RuntimeBackendId };
