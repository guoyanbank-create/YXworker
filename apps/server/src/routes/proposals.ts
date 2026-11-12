/**
 * 提案路由（API_CONTRACT §4 / P1-3）：生成/讨论为 202 异步 Run，前端轮询 GET /api/runs/:id；
 * 采纳/拒绝为同步状态机操作（服务端权威写入 + 读回校验）。
 *
 * P1：generate/discuss 支持 provider 三选（openai-compatible|deepseek-anthropic|mock）与
 * referenceIds/referenceSectionIds 过滤注入；backend=mock 强制 mock provider（不虚报 dsh）；
 * 未配置凭据 → 400 credential_missing；引用/小节不属于项目 → 400 validation_error。
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig, TierName } from '../config.js';
import type { Db } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { LlmError } from '../llm/types.js';
import type { LlmProvider } from '../llm/types.js';
import {
  createRuntimeRegistry,
  effectiveBackendId,
  type ExecutionSelection,
  type RuntimeRegistry,
} from '../runtime/registry.js';
import { getDocument } from '../services/documentsService.js';
import * as proposalService from '../services/proposalService.js';
import * as runService from '../services/runService.js';
import type { Proposal, Run } from '../types.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

const tierSchema = z.enum(['draft', 'review', 'long_reasoning']);
const backendSchema = z.enum(['dsh', 'mock']);
const providerSchema = z.enum(['openai-compatible', 'deepseek-anthropic', 'mock']);
const faultSchema = z.enum(['rate_limit', 'server_error', 'network', 'timeout', 'data_policy']);
/** 引用/小节 id 列表（去重由服务层处理，归属由服务层校验）。 */
const idListSchema = z.array(z.string().trim().min(1).max(120)).max(50).optional();

const generateBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  tier: tierSchema.default('review'),
  backend: backendSchema.default('dsh'),
  /** P1：provider 三选；不传用服务端默认（P0 语义：默认真实网关）。 */
  provider: providerSchema.optional(),
  /** P1：只把指定引用/小节注入提示词；未传=全部。 */
  referenceIds: idListSchema,
  referenceSectionIds: idListSchema,
  count: z.number().int().min(1).max(10).default(5),
  fault: faultSchema.optional(),
});

const acceptBodySchema = z.object({
  reviewer: z.string().trim().max(120).optional(),
});

const rejectBodySchema = z.object({
  reviewer: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
});

const discussBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  tier: tierSchema.default('review'),
  /** 契约未列出；作为离线测试/演示的扩展，默认 dsh（真实网关）。 */
  backend: backendSchema.optional(),
  /** P1：讨论同样支持 provider 切换与引用过滤。 */
  provider: providerSchema.optional(),
  referenceIds: idListSchema,
  referenceSectionIds: idListSchema,
  fault: faultSchema.optional(),
});

function parseBody<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw badRequest('validation_error', '请求参数校验失败', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map((part) => String(part)).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data as z.infer<S>;
}

function throwEngineError(error: unknown): never {
  if (error instanceof LlmError) {
    throw new HttpError(error.httpStatus, error.code, error.message);
  }
  throw error;
}

/**
 * 数据分级阻断时仍需要写入 Run 的“尝试链路”来源（provider/model 必须真实可解释；
 * 不因凭据缺失伪造来源，也不发起任何模型调用）。
 */
function describeSelection(
  config: AppConfig,
  registry: RuntimeRegistry,
  input: { backend: string; provider?: string; tier: TierName },
): { backendId: 'dsh' | 'mock'; provider: LlmProvider; model: string } {
  const backendId = effectiveBackendId(config, input.backend, input.provider);
  if (backendId === 'mock') {
    return {
      backendId,
      provider: registry.llmRouter.mock,
      model: registry.llmRouter.modelFor('mock', input.tier),
    };
  }
  const provider =
    (input.provider ? registry.llmRouter.byId(input.provider) : undefined) ??
    registry.llmRouter.defaultProvider();
  return {
    backendId,
    provider,
    model: registry.llmRouter.modelFor(provider.id, input.tier),
  };
}

/**
 * 请求是否只在离线 mock 链路上运行（不产生任何外部外发）：
 * - backend=mock（契约强制 provider=mock）；
 * - 显式 provider=mock（backend=dsh 时由 DSH 流水线调用离线 mock provider）。
 * 用于数据分级判定：数据分级约束的是“发送到外部模型”，离线 mock 不涉及外发。
 */
function isOfflineMockRequest(
  config: AppConfig,
  backend: string,
  provider?: string,
): boolean {
  return effectiveBackendId(config, backend, provider) === 'mock' || provider === 'mock';
}

/**
 * 解析执行器/提供方并写出一条“已归并为模拟”的运行事件（仅当请求被强制改写）。
 * 返回最新 Run（事件写入后）。
 */
function appendMockForcedEvent(
  db: Db,
  run: Run,
  selection: ExecutionSelection,
): Run {
  if (!selection.forcedMock) return run;
  return runService.appendRunEvent(db, run.id, {
    level: 'warn',
    message: '已按契约强制使用模拟提供方（provider=mock）；该运行结果必须标注“模拟”',
    data: {
      backend: selection.backendId,
      provider: selection.provider.id,
      mock: true,
      forcedMock: true,
    },
  });
}

export function createProposalsRouter(deps: RouterDeps): Router {
  const { db, config } = deps;
  const router = Router();

  router.get('/proposals/:id', (req, res) => {
    const proposal = proposalService.getProposal(db, req.params.id);
    res.json({ proposal });
  });

  router.get('/documents/:id/proposals', (req, res) => {
    // 文档不存在时 404（与 documents 路由一致）。
    getDocument(db, req.params.id);
    const proposals = proposalService.listProposals(db, req.params.id);
    res.json({ proposals });
  });

  router.post('/documents/:id/proposals/generate', (req, res) => {
    const body = parseBody(generateBodySchema, req.body);
    const document = getDocument(db, req.params.id);
    const project = proposalService.getProjectBrief(db, document.projectId);
    if (!project) throw notFound('not_found', '项目不存在');
    const registry = createRuntimeRegistry(config);

    let selection: ExecutionSelection;
    try {
      // 数据分级优先于凭据校验：secret 一律阻断外部模型（API_CONTRACT §4.5）。
      // 离线 mock provider 不产生外发（即使显式 backend=dsh），secret 项目仍可演示。
      proposalService.assertProjectAllowsExternalModel(
        project,
        isOfflineMockRequest(config, body.backend, body.provider) ? 'mock' : 'dsh',
      );
      selection = registry.selectExecution({
        backend: body.backend,
        provider: body.provider,
        tier: body.tier,
      });
    } catch (error) {
      if (error instanceof LlmError && error.code === 'data_policy_blocked') {
        const blocked = describeSelection(config, registry, {
          backend: body.backend,
          provider: body.provider,
          tier: body.tier,
        });
        const blockedRun = proposalService.createBlockedRun(
          db,
          {
            projectId: project.id,
            documentId: document.id,
            type: 'proposal_generation',
            backend: blocked.backendId,
            provider: blocked.provider.id,
            model: blocked.model,
            tier: body.tier,
            prompt: body.prompt,
          },
          { code: error.code, message: error.message, retryable: false },
        );
        throw new HttpError(403, error.code, error.message, { run: blockedRun });
      }
      throwEngineError(error);
    }

    // 引用/小节归属校验：不属于本项目 → 400 validation_error（不创建 Run）。
    proposalService.assertReferenceSelection(db, project.id, {
      referenceIds: body.referenceIds,
      referenceSectionIds: body.referenceSectionIds,
    });

    let run = runService.createRun(db, {
      projectId: project.id,
      documentId: document.id,
      type: 'proposal_generation',
      backend: selection.backendId,
      provider: selection.provider.id,
      model: selection.model,
      tier: body.tier,
      prompt: body.prompt,
    });
    run = appendMockForcedEvent(db, run, selection);

    proposalService.startGenerationRun(
      { db, config },
      {
        run,
        project,
        document,
        request: {
          prompt: body.prompt,
          tier: body.tier,
          backend: selection.backendId,
          provider: selection.provider.id,
          referenceIds: body.referenceIds,
          referenceSectionIds: body.referenceSectionIds,
          count: body.count,
          fault: body.fault,
        },
      },
    );
    res.status(202).json({ run });
  });

  router.post('/proposals/:id/accept', (req, res) => {
    const body = parseBody(acceptBodySchema, req.body);
    const result = proposalService.acceptProposal(db, req.params.id, {
      reviewer: body.reviewer,
    });
    res.json({ proposal: result.proposal, document: result.document });
  });

  router.post('/proposals/:id/reject', (req, res) => {
    const body = parseBody(rejectBodySchema, req.body);
    const proposal = proposalService.rejectProposal(db, req.params.id, {
      reviewer: body.reviewer,
      note: body.note,
    });
    res.json({ proposal });
  });

  router.post('/proposals/:id/discuss', (req, res) => {
    const body = parseBody(discussBodySchema, req.body);
    const proposal: Proposal = proposalService.getProposal(db, req.params.id);
    if (!['proposed', 'revised'].includes(proposal.status)) {
      throw conflict('proposal_state_invalid', `提案当前状态为 ${proposal.status}，不允许继续讨论`, {
        proposal,
      });
    }
    const document = getDocument(db, proposal.documentId);
    const project = proposalService.getProjectBrief(db, document.projectId);
    if (!project) throw notFound('not_found', '项目不存在');
    // 契约未给 discuss 指定 backend：默认沿用该提案生成时的执行器（mock 生成 → mock 讨论，离线演示可用）。
    const requestedBackend: 'dsh' | 'mock' =
      body.backend ?? (proposal.backend === 'mock' ? 'mock' : 'dsh');
    const registry = createRuntimeRegistry(config);

    let selection: ExecutionSelection;
    try {
      proposalService.assertProjectAllowsExternalModel(
        project,
        isOfflineMockRequest(config, requestedBackend, body.provider) ? 'mock' : 'dsh',
      );
      selection = registry.selectExecution({
        backend: requestedBackend,
        provider: body.provider,
        tier: body.tier,
      });
    } catch (error) {
      if (error instanceof LlmError && error.code === 'data_policy_blocked') {
        const blocked = describeSelection(config, registry, {
          backend: requestedBackend,
          provider: body.provider,
          tier: body.tier,
        });
        const blockedRun = proposalService.createBlockedRun(
          db,
          {
            projectId: project.id,
            documentId: document.id,
            type: 'discussion',
            backend: blocked.backendId,
            provider: blocked.provider.id,
            model: blocked.model,
            tier: body.tier,
            prompt: body.message,
          },
          { code: error.code, message: error.message, retryable: false },
        );
        throw new HttpError(403, error.code, error.message, { run: blockedRun });
      }
      throwEngineError(error);
    }

    proposalService.assertReferenceSelection(db, project.id, {
      referenceIds: body.referenceIds,
      referenceSectionIds: body.referenceSectionIds,
    });

    let run: Run = runService.createRun(db, {
      projectId: project.id,
      documentId: document.id,
      type: 'discussion',
      backend: selection.backendId,
      provider: selection.provider.id,
      model: selection.model,
      tier: body.tier,
      prompt: body.message,
    });
    run = appendMockForcedEvent(db, run, selection);

    proposalService.startDiscussionRun(
      { db, config },
      {
        run,
        project,
        document,
        proposal,
        request: {
          message: body.message,
          tier: body.tier,
          backend: selection.backendId,
          provider: selection.provider.id,
          referenceIds: body.referenceIds,
          referenceSectionIds: body.referenceSectionIds,
          fault: body.fault,
        },
      },
    );
    res.status(202).json({ run });
  });

  return router;
}
