/**
 * 状态接口（API_CONTRACT §1 / P1-3）：返回 provider/backend 可用性、数据分级策略与演示开关。
 * P1：新增 `current`（当前生效执行器/provider/model 与超时上限）与 provider 的 `current` 标记；
 * 超时数值直接取自 runService.runWatchdogTimeoutMs()（默认 60s，看门狗=+30s），与真实调用一致。
 * 不暴露密钥、完整 baseUrl（最多返回 host）或任何凭据派生信息。
 */
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { createRuntimeRegistry } from '../runtime/registry.js';
import * as runService from '../services/runService.js';
import type { CurrentModelStatus, DataLevel, StatusResponse } from '../types.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

/** 看门狗在模型超时基础上的固定余量（与 runService 实现一致）。 */
const WATCHDOG_GRACE_MS = 30_000;

export function createStatusRouter(deps: RouterDeps): Router {
  const { config } = deps;
  const router = Router();

  router.get('/status', (_req, res) => {
    const registry = createRuntimeRegistry(config);
    const currentProvider = registry.llmRouter.currentProvider();
    const realModelConfigured = registry.llmRouter.realProviderConfigured();
    const watchdogTimeoutMs = runService.runWatchdogTimeoutMs();
    const modelTimeoutMs = Math.max(1, watchdogTimeoutMs - WATCHDOG_GRACE_MS);
    const current: CurrentModelStatus = {
      // current 表示“当前实际生效链路”：mockOnly 或无真实凭据时回退 mock（providerId 可直接用于请求默认值）。
      backend: config.mockOnly || !realModelConfigured ? 'mock' : 'dsh',
      providerId: currentProvider.id,
      providerLabel: currentProvider.label,
      providerKind: registry.llmRouter.providerKind(currentProvider.id),
      model: registry.llmRouter.modelFor(currentProvider.id, 'review'),
      modelTimeoutMs,
      watchdogTimeoutMs,
      realModelConfigured,
    };

    const body: StatusResponse = {
      app: {
        name: config.appName,
        version: config.version,
        mockMode: config.mockOnly,
      },
      current,
      providers: registry.llmRouter.providerStatuses(),
      backends: registry.statuses(),
      dataPolicy: {
        defaultLevel: config.dataPolicy.defaultLevel,
        externalProvidersAllowedFor: [...config.dataPolicy.externalProvidersAllowedFor] as DataLevel[],
        note: config.dataPolicy.note,
      },
      faultInjectionEnabled: config.faultInjection,
      features: {
        proposalGeneration: true,
        proposalDiscussion: true,
        proposalAccept: true,
        proposalReject: true,
        safeRebase: true,
        conflictDetection: true,
        runPolling: true,
        runCancel: true,
        versionHistory: true,
        docxExport: true,
        referencesUpload: true,
        mockModeAvailable: true,
        // P1
        referenceSections: true,
        referenceLocators: true,
        providerSelection: true,
        currentModelStatus: true,
        runWatchdog: true,
      },
      limits: {
        modelTimeout: `${modelTimeoutMs}ms（可用 YXWORKER_LLM_TIMEOUT_MS 覆盖）`,
        watchdogTimeout: `${watchdogTimeoutMs}ms（模型超时 + ${WATCHDOG_GRACE_MS}ms）`,
        proposalCount: '1-10（默认 5）',
        promptMaxChars: '4000',
        referenceMaxBytes: '10MB（docx/md/txt）',
        referenceLocatorLimit: '1-50（默认 20）',
        runPollInterval: '300-500ms（前端）',
      },
    };
    res.json(body);
  });

  return router;
}
