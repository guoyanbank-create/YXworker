/**
 * LLM Provider 路由：按服务端配置选择可用 provider，并生成 /api/status 的安全状态。
 * 凭据只在服务端内存；状态接口只返回 provider id / 是否配置 / host（不含完整 baseUrl 与密钥）。
 */
import type { AppConfig, TierName } from '../config.js';
import type { ProviderStatus } from '../types.js';
import {
  createDeepseekAnthropicProvider,
  deepseekModelForTier,
} from './deepseekAnthropicProvider.js';
import { createMockProvider, MOCK_MODEL } from './mockProvider.js';
import { createOpenAiCompatibleProvider, modelForTier } from './openaiCompatibleProvider.js';
import type { LlmProvider, LlmProviderId } from './types.js';

export interface LlmRouter {
  providers: LlmProvider[];
  mock: LlmProvider;
  byId(id: string): LlmProvider | undefined;
  /** 默认真实 provider（网关优先，官方端点次之；均未配置时返回网关以便给出 credential_missing）。 */
  defaultProvider(): LlmProvider;
  modelFor(providerId: string, tier: TierName): string;
  realProviderConfigured(): boolean;
  providerStatuses(): ProviderStatus[];
}

/** 只暴露 host，绝不返回完整 URL（契约要求不暴露完整 baseUrl）。 */
export function safeHost(baseUrl: string): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function allTiers(): string[] {
  return ['draft', 'review', 'long_reasoning'];
}

export function createLlmRouter(cfg: AppConfig): LlmRouter {
  const openai = createOpenAiCompatibleProvider({ config: cfg.llm });
  const anthropic = createDeepseekAnthropicProvider({
    config: cfg.deepseek,
    longReasoningModel: cfg.llm.modelPro,
  });
  const mock = createMockProvider();
  const providers: LlmProvider[] = [openai, anthropic, mock];

  function defaultProvider(): LlmProvider {
    if (cfg.llm.kind === 'deepseek-anthropic' && anthropic.configured) return anthropic;
    if (openai.configured) return openai;
    if (anthropic.configured) return anthropic;
    return openai;
  }

  return {
    providers,
    mock,
    byId(id: string): LlmProvider | undefined {
      return providers.find((provider) => provider.id === id);
    },
    defaultProvider,
    modelFor(providerId: string, tier: TierName): string {
      if (providerId === 'mock') return MOCK_MODEL;
      if (providerId === 'deepseek-anthropic') {
        return deepseekModelForTier(
          { config: cfg.deepseek, longReasoningModel: cfg.llm.modelPro },
          tier,
        );
      }
      return modelForTier(cfg.llm, tier);
    },
    realProviderConfigured(): boolean {
      return openai.configured || anthropic.configured;
    },
    providerStatuses(): ProviderStatus[] {
      return [
        {
          id: openai.id,
          label: openai.label,
          configured: openai.configured,
          baseUrl: openai.configured ? safeHost(cfg.llm.baseUrl) : null,
          models: openai.models,
          tiers: openai.configured ? allTiers() : [],
          blockedByDataPolicy: false,
          note: openai.configured
            ? '密钥仅服务端持有；网关使用 json_object + 服务端 zod 校验，失败一次修复重试。'
            : '未配置网关凭据（YXWORKER_LLM_BASE_URL / YXWORKER_LLM_API_KEY）。',
        },
        {
          id: anthropic.id,
          label: anthropic.label,
          configured: anthropic.configured,
          baseUrl: anthropic.configured ? safeHost(cfg.deepseek.anthropicBaseUrl) : null,
          models: anthropic.models,
          tiers: anthropic.configured ? allTiers() : [],
          blockedByDataPolicy: false,
          note: anthropic.configured
            ? '官方 Anthropic 兼容端点（可选）；结构化输出同样由服务端校验。'
            : '未配置 DeepSeek 官方端点凭据（DEEPSEEK_API_KEY）。',
        },
        {
          id: mock.id,
          label: mock.label,
          configured: true,
          baseUrl: null,
          models: [MOCK_MODEL],
          tiers: allTiers(),
          blockedByDataPolicy: false,
          note: '离线确定性模拟，不访问外部网络；使用该执行器时 UI/运行记录必须标注“模拟”。',
        },
      ];
    },
  };
}

export type { LlmProviderId };
