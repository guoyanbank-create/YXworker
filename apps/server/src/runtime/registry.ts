/** 执行器注册表：装配 DSH（默认）/ Mock / Codex（仅探测），供路由与状态接口使用。 */
import type { AppConfig } from '../config.js';
import { LlmError } from '../llm/types.js';
import { createLlmRouter } from '../llm/router.js';
import type { LlmRouter } from '../llm/router.js';
import type { BackendStatus } from '../types.js';
import { createCodexBackend } from './codexBackend.js';
import { createDshBackend } from './dshBackend.js';
import { createMockBackend } from './mockBackend.js';
import type { ExecutionBackend, RuntimeBackendId } from './types.js';

export interface RuntimeRegistry {
  backends: ExecutionBackend[];
  llmRouter: LlmRouter;
  byId(id: string): ExecutionBackend | undefined;
  /** 状态接口展示顺序：dsh / mock / codex。 */
  statuses(): BackendStatus[];
  /** 生成/讨论请求选择的执行器；不可用时抛 LlmError（路由转 HTTP 错误）。 */
  assertSelectable(id: string): ExecutionBackend;
}

export function createRuntimeRegistry(cfg: AppConfig): RuntimeRegistry {
  const llmRouter = createLlmRouter(cfg);
  const backends: ExecutionBackend[] = [
    createDshBackend(cfg, { router: llmRouter }),
    createMockBackend(),
    createCodexBackend(),
  ];

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
  };
}

export type { RuntimeBackendId };
