/**
 * 状态接口（API_CONTRACT §1）：返回 provider/backend 可用性、数据分级策略与演示开关。
 * 不暴露密钥、完整 baseUrl（最多返回 host）或任何凭据派生信息。
 */
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { createRuntimeRegistry } from '../runtime/registry.js';
import type { DataLevel, StatusResponse } from '../types.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

export function createStatusRouter(deps: RouterDeps): Router {
  const { config } = deps;
  const router = Router();

  router.get('/status', (_req, res) => {
    const registry = createRuntimeRegistry(config);
    const body: StatusResponse = {
      app: {
        name: config.appName,
        version: config.version,
        mockMode: config.mockOnly,
      },
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
      },
      limits: {
        modelTimeout: '60000ms（可用 YXWORKER_LLM_TIMEOUT_MS 覆盖）',
        proposalCount: '1-10（默认 5）',
        promptMaxChars: '4000',
        referenceMaxBytes: '10MB（docx/md/txt）',
        runPollInterval: '300-500ms（前端）',
      },
    };
    res.json(body);
  });

  return router;
}
