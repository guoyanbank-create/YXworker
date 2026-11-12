/**
 * CodexExecutionBackend：P0 仅做可用性探测。
 * 本机未安装 Codex App Server/CLI 时明确标记 unavailable，不参与默认路径、不冒充已接入。
 * 探测只检查环境变量与常见安装路径（只读），不执行任意命令。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '../llm/types.js';
import type {
  BackendCapabilities,
  ExecutionBackend,
  ExecutionContext,
  ExecutionResult,
  ExecutionTask,
} from './types.js';

function detectCodex(): { available: boolean; reason: string } {
  const envMarker = process.env.CODEX_HOME;
  const candidates = [
    envMarker ? join(envMarker, 'config.toml') : '',
    join(homedir(), '.codex', 'config.toml'),
  ].filter((item) => item.length > 0);
  if (process.env.YXWORKER_CODEX_AVAILABLE === '1') {
    return {
      available: true,
      reason: '检测到 YXWORKER_CODEX_AVAILABLE=1（仅探测标记；P0 默认仍使用 DSH 执行器）。',
    };
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        available: false,
        reason:
          '检测到 ~/.codex 配置，但 P0 未验证 Codex App Server 端到端连接，暂不参与默认路径（不冒充已接入）。',
      };
    }
  }
  return {
    available: false,
    reason: '本机未安装/未配置 Codex（无 ~/.codex），P0 不依赖 Codex，默认使用 DSH 执行器。',
  };
}

export function createCodexBackend(): ExecutionBackend {
  return {
    id: 'codex',
    capabilities(): BackendCapabilities {
      const detection = detectCodex();
      return {
        id: 'codex',
        label: 'Codex（仅探测）',
        available: detection.available,
        mock: false,
        reason: detection.reason,
      };
    },
    async start(_task: ExecutionTask, _ctx: ExecutionContext): Promise<ExecutionResult> {
      throw new LlmError('backend_unavailable', 'Codex 执行器在 P0 不可用（仅探测，不参与默认路径）', {
        retryable: false,
      });
    },
    cancel(): boolean {
      return false;
    },
    resume(): boolean {
      return false;
    },
  };
}
