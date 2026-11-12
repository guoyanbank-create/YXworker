/**
 * 提案路由（API_CONTRACT §4）：生成/讨论为 202 异步 Run，前端轮询 GET /api/runs/:id；
 * 采纳/拒绝为同步状态机操作（服务端权威写入 + 读回校验）。
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { LlmError } from '../llm/types.js';
import { createRuntimeRegistry } from '../runtime/registry.js';
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
const faultSchema = z.enum(['rate_limit', 'server_error', 'network', 'timeout', 'data_policy']);

const generateBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  tier: tierSchema.default('review'),
  backend: backendSchema.default('dsh'),
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

    // 数据分级优先于凭据校验：secret 一律阻断外部模型（API_CONTRACT §4.5 / §10）。
    try {
      proposalService.assertProjectAllowsExternalModel(project, body.backend);
      registry.assertSelectable(body.backend);
    } catch (error) {
      if (error instanceof LlmError && error.code === 'data_policy_blocked') {
        const provider = registry.llmRouter.defaultProvider();
        const blockedRun = proposalService.createBlockedRun(
          db,
          {
            projectId: project.id,
            documentId: document.id,
            type: 'proposal_generation',
            backend: body.backend,
            provider: provider.id,
            model: registry.llmRouter.modelFor(provider.id, body.tier),
            tier: body.tier,
            prompt: body.prompt,
          },
          { code: error.code, message: error.message, retryable: false },
        );
        throw new HttpError(403, error.code, error.message, { run: blockedRun });
      }
      throwEngineError(error);
    }

    const providerModel = proposalService.resolveRunProviderModel(
      config,
      body.backend,
      body.tier,
    );
    const run = runService.createRun(db, {
      projectId: project.id,
      documentId: document.id,
      type: 'proposal_generation',
      backend: body.backend,
      provider: providerModel.provider,
      model: providerModel.model,
      tier: body.tier,
      prompt: body.prompt,
    });
    proposalService.startGenerationRun(
      { db, config },
      {
        run,
        project,
        document,
        request: {
          prompt: body.prompt,
          tier: body.tier,
          backend: body.backend,
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
    const backendId: 'dsh' | 'mock' =
      body.backend ?? (proposal.backend === 'mock' ? 'mock' : 'dsh');
    const registry = createRuntimeRegistry(config);

    try {
      proposalService.assertProjectAllowsExternalModel(project, backendId);
      registry.assertSelectable(backendId);
    } catch (error) {
      if (error instanceof LlmError && error.code === 'data_policy_blocked') {
        const provider = registry.llmRouter.defaultProvider();
        const blockedRun = proposalService.createBlockedRun(
          db,
          {
            projectId: project.id,
            documentId: document.id,
            type: 'discussion',
            backend: backendId,
            provider: provider.id,
            model: registry.llmRouter.modelFor(provider.id, body.tier),
            tier: body.tier,
            prompt: body.message,
          },
          { code: error.code, message: error.message, retryable: false },
        );
        throw new HttpError(403, error.code, error.message, { run: blockedRun });
      }
      throwEngineError(error);
    }

    const providerModel = proposalService.resolveRunProviderModel(
      config,
      backendId,
      body.tier,
    );
    const run: Run = runService.createRun(db, {
      projectId: project.id,
      documentId: document.id,
      type: 'discussion',
      backend: backendId,
      provider: providerModel.provider,
      model: providerModel.model,
      tier: body.tier,
      prompt: body.message,
    });
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
          backend: backendId,
          fault: body.fault,
        },
      },
    );
    res.status(202).json({ run });
  });

  return router;
}
