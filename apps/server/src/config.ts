/**
 * 服务端配置。模型凭据只允许在服务端读取：
 * 优先级 process.env > ~/.config/yxworker/credentials.env（或 YXWORKER_CREDENTIALS_FILE）。
 * 凭据绝不写入仓库、数据库、日志或前端响应；本模块只做内存持有。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type TierName = 'draft' | 'review' | 'long_reasoning';

function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function loadCredentialFile(): Record<string, string> {
  const explicit = process.env.YXWORKER_CREDENTIALS_FILE;
  const candidates = explicit
    ? [isAbsolute(explicit) ? explicit : resolve(explicit)]
    : [join(homedir(), '.config', 'yxworker', 'credentials.env')];
  for (const file of candidates) {
    try {
      return parseEnvFile(readFileSync(file, 'utf8'));
    } catch {
      // 凭据文件缺失是合法状态：真实模型不可用，UI 显示“未配置”，Mock 仍可用。
    }
  }
  return {};
}

const fromFile = loadCredentialFile();

function pick(key: string, fallback = ''): string {
  return process.env[key] ?? fromFile[key] ?? fallback;
}

export interface LlmProviderConfig {
  /** 网关类型：openai-compatible（默认，本机网关）或 deepseek-anthropic（官方 anthropic 端点）。 */
  kind: 'openai-compatible' | 'deepseek-anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  modelPro: string;
  tiers: Record<TierName, string>;
}

const repoRoot = resolve(process.cwd());

export const config = {
  appName: 'YXworker',
  version: '0.1.0-p0',
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: process.env.YXWORKER_DATA_DIR
    ? resolve(process.env.YXWORKER_DATA_DIR)
    : join(repoRoot, '.data'),
  webDist: process.env.YXWORKER_WEB_DIST
    ? resolve(process.env.YXWORKER_WEB_DIST)
    : join(repoRoot, 'apps', 'web', 'dist'),
  /** 模拟故障注入开关（本机演示/测试用，默认开启；仅影响模拟执行器与显式请求）。 */
  faultInjection: process.env.YXWORKER_FAULT_INJECTION !== '0',
  /** 强制只使用 Mock 执行器（离线测试用）。 */
  mockOnly: process.env.YXWORKER_MOCK_ONLY === '1',
  /** 脱敏/虚构材料允许直连外部网关；secret 级别一律阻断（PRODUCT_SPEC §10）。 */
  dataPolicy: {
    defaultLevel: 'internal' as const,
    externalProvidersAllowedFor: ['public', 'internal'] as const,
    note: '对外部模型网关仅允许 public/internal 级材料；secret 一律阻断并提示。',
  },
  llm: {
    kind: pick('YXWORKER_LLM_PROVIDER', 'openai-compatible') as LlmProviderConfig['kind'],
    baseUrl: pick('YXWORKER_LLM_BASE_URL', ''),
    apiKey: pick('YXWORKER_LLM_API_KEY', ''),
    model: pick('YXWORKER_LLM_MODEL', 'deepseek-flash'),
    modelPro: pick('YXWORKER_LLM_MODEL_PRO', 'deepseek-v4-pro'),
    tiers: {
      draft: pick('YXWORKER_TIER_DRAFT', pick('YXWORKER_LLM_MODEL', 'deepseek-flash')),
      review: pick('YXWORKER_TIER_REVIEW', pick('YXWORKER_LLM_MODEL', 'deepseek-flash')),
      long_reasoning: pick('YXWORKER_TIER_LONG_REASONING', pick('YXWORKER_LLM_MODEL_PRO', 'deepseek-v4-pro')),
    },
  } satisfies LlmProviderConfig,
  deepseek: {
    apiKey: pick('DEEPSEEK_API_KEY', ''),
    anthropicBaseUrl: pick('DEEPSEEK_ANTHROPIC_BASE_URL', 'https://api.deepseek.com/anthropic'),
    model: pick('DEEPSEEK_MODEL', 'deepseek-flash'),
  },
  /** 网关/官方端点均未配置时为 true。 */
  get llmConfigured(): boolean {
    return Boolean(config.llm.baseUrl && config.llm.apiKey) || Boolean(config.deepseek.apiKey);
  },
  dbFile: join(
    process.env.YXWORKER_DATA_DIR
      ? resolve(process.env.YXWORKER_DATA_DIR)
      : join(repoRoot, '.data'),
    'yxworker.sqlite',
  ),
  /** 演示种子数据开关：默认开启；测试可用 YXWORKER_NO_SEED=1 关闭。 */
  seedDemo: process.env.YXWORKER_NO_SEED !== '1',
};

export type AppConfig = typeof config;
