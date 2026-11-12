/**
 * 本机后端 API 客户端（契约见 docs/API_CONTRACT.md）。
 *
 * - 所有请求走同源 `/api`（开发期由 Vite 代理到 127.0.0.1:8787）。
 * - 统一错误模型 `ApiError { status, code, message, details }`：后端错误体
 *   `{ error: { code, message, details? } }` 原样保留，供 UI 做错误分流。
 * - 不保存任何密钥：前端只发请求，凭据始终由服务端持有。
 */
import type {
  BatchAcceptResult,
  DataLevel,
  Diagram,
  Document,
  DocumentSummary,
  DocumentTemplateInfo,
  ExecutionBackendId,
  FaultKind,
  FeatureSpec,
  ImpactPlan,
  Project,
  Proposal,
  ProviderId,
  Reference,
  ReferenceLocatorResult,
  ReferenceSection,
  Run,
  StatusResponse,
  Tier,
  Version,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

/** 面向用户的操作建议：把错误码翻译成可执行提示（API 契约 §0 错误码）。 */
export function errorHint(code: string | null): string | null {
  switch (code) {
    case 'credential_missing':
      return '真实模型凭据未配置：请在左侧把执行器切换为「模拟」，或由管理员配置 ~/.config/yxworker/credentials.env。';
    case 'data_policy_blocked':
      return '数据分级为「机密」时禁止发送到外部模型，文档未受影响。可将数据分级改回「内部」或使用模拟执行器。';
    case 'model_rate_limited':
      return '模型网关限流（429），请稍后重试或切换模拟执行器。';
    case 'model_unavailable':
      return '模型网关不可用（5xx/网络错误），文档未受影响，可稍后重试。';
    case 'model_timeout':
      return '模型请求超时（90s），可稍后重试或改用模拟执行器。';
    case 'model_schema_invalid':
      return '模型输出经修复重试后仍不符合提案 Schema，请重试或改用模拟执行器。';
    case 'backend_unavailable':
      return '所选执行器不可用，请切换为 DSH 或模拟执行器。';
    case 'revision_conflict':
      return '文档版本已变化，界面会重新拉取后再保存。';
    case 'proposal_conflicted':
      return '目标段落已被人工修改，该建议不可覆盖，只能拒绝或继续讨论。';
    case 'proposal_state_invalid':
      return '该建议当前状态不允许此操作，请刷新建议列表后重试。';
    case 'network_error':
      return '无法连接本机后端服务，请确认已运行 pnpm dev:server（127.0.0.1:8787）。';
    default:
      return null;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(
      0,
      'network_error',
      '无法连接本机后端服务（127.0.0.1:8787）。请确认已启动后端，然后重试。',
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorBody = (body ?? {}) as ErrorBody;
    const code = errorBody.error?.code ?? `http_${response.status}`;
    const message = errorBody.error?.message ?? `请求失败（HTTP ${response.status}）`;
    throw new ApiError(response.status, code, message, errorBody.error?.details);
  }

  return body as T;
}

const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// 状态与项目
// ---------------------------------------------------------------------------

export function getStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/api/status');
}

export function listProjects(): Promise<{ projects: Project[] }> {
  return request<{ projects: Project[] }>('/api/projects');
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  dataLevel?: DataLevel;
}

export function createProject(input: CreateProjectInput): Promise<{ project: Project }> {
  return request<{ project: Project }>('/api/projects', {
    method: 'POST',
    body: json(input),
  });
}

export function getProject(
  projectId: string,
): Promise<{ project: Project; document: DocumentSummary }> {
  return request<{ project: Project; document: DocumentSummary }>(`/api/projects/${projectId}`);
}

export interface PatchProjectInput {
  name?: string;
  description?: string;
  dataLevel?: DataLevel;
}

export function patchProject(projectId: string, input: PatchProjectInput): Promise<{ project: Project }> {
  return request<{ project: Project }>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: json(input),
  });
}

export function listProjectRuns(projectId: string, limit = 20): Promise<{ runs: Run[] }> {
  return request<{ runs: Run[] }>(`/api/projects/${projectId}/runs?limit=${limit}`);
}

// ---------------------------------------------------------------------------
// 文档与自动保存
// ---------------------------------------------------------------------------

export function getDocument(documentId: string): Promise<{ document: Document }> {
  return request<{ document: Document }>(`/api/documents/${documentId}`);
}

export interface SaveContentInput {
  contentJson: unknown;
  baseRevision: number;
  actor?: string;
}

export interface SaveContentResult {
  document: Document;
  conflictedProposals: Proposal[];
}

export function saveDocumentContent(
  documentId: string,
  input: SaveContentInput,
): Promise<SaveContentResult> {
  return request<SaveContentResult>(`/api/documents/${documentId}/content`, {
    method: 'PUT',
    body: json(input),
  });
}

// ---------------------------------------------------------------------------
// 提案
// ---------------------------------------------------------------------------

export function listProposals(documentId: string): Promise<{ proposals: Proposal[] }> {
  return request<{ proposals: Proposal[] }>(`/api/documents/${documentId}/proposals`);
}

export function getProposal(proposalId: string): Promise<{ proposal: Proposal }> {
  return request<{ proposal: Proposal }>(`/api/proposals/${proposalId}`);
}

export interface GenerateInput {
  prompt: string;
  tier?: Tier;
  backend?: ExecutionBackendId;
  count?: number;
  fault?: FaultKind;
  /** P1：模型提供方三选；不传用服务端 status.current 默认值。 */
  provider?: ProviderId;
  /** P1：只把指定引用 / 小节注入提示词（须属于本项目）。 */
  referenceIds?: string[];
  referenceSectionIds?: string[];
}

export function generateProposals(
  documentId: string,
  input: GenerateInput,
): Promise<{ run: Run }> {
  return request<{ run: Run }>(`/api/documents/${documentId}/proposals/generate`, {
    method: 'POST',
    body: json(input),
  });
}

export function acceptProposal(
  proposalId: string,
  reviewer?: string,
): Promise<{ proposal: Proposal; document: Document }> {
  return request<{ proposal: Proposal; document: Document }>(`/api/proposals/${proposalId}/accept`, {
    method: 'POST',
    body: json({ reviewer }),
  });
}

export function rejectProposal(
  proposalId: string,
  input: { reviewer?: string; note?: string } = {},
): Promise<{ proposal: Proposal }> {
  return request<{ proposal: Proposal }>(`/api/proposals/${proposalId}/reject`, {
    method: 'POST',
    body: json(input),
  });
}

export interface DiscussInput {
  message: string;
  tier?: Tier;
  fault?: FaultKind;
  /** P1：讨论同样支持 provider 切换。 */
  provider?: ProviderId;
}

export function discussProposal(proposalId: string, input: DiscussInput): Promise<{ run: Run }> {
  return request<{ run: Run }>(`/api/proposals/${proposalId}/discuss`, {
    method: 'POST',
    body: json(input),
  });
}

// ---------------------------------------------------------------------------
// 运行记录
// ---------------------------------------------------------------------------

export function getRun(runId: string): Promise<{ run: Run }> {
  return request<{ run: Run }>(`/api/runs/${runId}`);
}

export function cancelRun(runId: string): Promise<{ run: Run }> {
  return request<{ run: Run }>(`/api/runs/${runId}/cancel`, { method: 'POST', body: json({}) });
}

// ---------------------------------------------------------------------------
// 版本与导出
// ---------------------------------------------------------------------------

export function listVersions(documentId: string): Promise<{ versions: Version[] }> {
  return request<{ versions: Version[] }>(`/api/documents/${documentId}/versions`);
}

export function createVersion(documentId: string, name: string): Promise<{ version: Version }> {
  return request<{ version: Version }>(`/api/documents/${documentId}/versions`, {
    method: 'POST',
    body: json({ name }),
  });
}

export function restoreVersion(versionId: string): Promise<{ document: Document }> {
  return request<{ document: Document }>(`/api/versions/${versionId}/restore`, {
    method: 'POST',
    body: json({}),
  });
}

export type ExportTemplate = 'gov' | 'tech';

export function exportDocxUrl(
  documentId: string,
  versionId?: string,
  template: ExportTemplate = 'tech',
): string {
  const params = new URLSearchParams();
  if (versionId) params.set('versionId', versionId);
  params.set('template', template);
  return `/api/documents/${documentId}/export.docx?${params.toString()}`;
}

/** 下载 DOCX 并触发浏览器保存；返回实际文件名。 */
export async function downloadDocx(
  documentId: string,
  versionId?: string,
  template: ExportTemplate = 'tech',
): Promise<string> {
  const path = exportDocxUrl(documentId, versionId, template);
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new ApiError(0, 'network_error', '无法连接本机后端服务，导出失败。');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let code = `http_${response.status}`;
    let message = `导出失败（HTTP ${response.status}）`;
    try {
      const body = JSON.parse(text) as ErrorBody;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* 非 JSON 错误体保持默认提示 */
    }
    throw new ApiError(response.status, code, message);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const fallback = versionId ? 'yxworker-version.docx' : 'yxworker-document.docx';
  let filename = fallback;
  if (filenameMatch?.[1]) {
    try {
      filename = decodeURIComponent(filenameMatch[1].replace(/^"|"$/g, ''));
    } catch {
      filename = filenameMatch[1].replace(/^"|"$/g, '');
    }
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return filename;
}

// ---------------------------------------------------------------------------
// 引用资料
// ---------------------------------------------------------------------------

export function listReferences(projectId: string): Promise<{ references: Reference[] }> {
  return request<{ references: Reference[] }>(`/api/projects/${projectId}/references`);
}

export function uploadReference(projectId: string, file: File): Promise<{ reference: Reference }> {
  const form = new FormData();
  form.append('file', file);
  return request<{ reference: Reference }>(`/api/projects/${projectId}/references`, {
    method: 'POST',
    body: form,
  });
}

// ---------------------------------------------------------------------------
// 轮询辅助
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const RUN_POLL_INTERVAL_MS = 400;

export function isRunActive(run: Run | null | undefined): boolean {
  return run != null && (run.status === 'queued' || run.status === 'running');
}

// ---------------------------------------------------------------------------
// P1：引用资料定位（小节 / locator 检索 / 来源打开）
// ---------------------------------------------------------------------------

/** 引用项的已切分小节（按 paragraphIndex 升序），用于 @ 选择器与来源弹窗。 */
export function listReferenceSections(
  projectId: string,
  referenceId: string,
): Promise<{ reference: Reference; sections: ReferenceSection[] }> {
  return request<{ reference: Reference; sections: ReferenceSection[] }>(
    `/api/projects/${projectId}/references/${referenceId}/sections`,
  );
}

/** 单个小节完整内容（“卡片可点开来源”用）。 */
export function getReferenceSection(
  projectId: string,
  referenceId: string,
  sectionId: string,
): Promise<{ reference: Reference; section: ReferenceSection }> {
  return request<{ reference: Reference; section: ReferenceSection }>(
    `/api/projects/${projectId}/references/${referenceId}/sections/${sectionId}`,
  );
}

/** 跨本项目全部引用检索 locator + excerpt（@ 输入框搜索）。 */
export function searchReferenceLocators(
  projectId: string,
  q: string,
  limit = 20,
): Promise<{ results: ReferenceLocatorResult[] }> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return request<{ results: ReferenceLocatorResult[] }>(
    `/api/projects/${projectId}/references/locators?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// P2：Mermaid 图表（源码 + 版本绑定）
// ---------------------------------------------------------------------------

export interface DiagramInput {
  title: string;
  kind?: string;
  source: string;
  description?: string;
  chapterRef?: string | null;
  /** 传命名版本 id 则绑定该版本 revision+name；不传默认当前文档 revision。 */
  versionId?: string;
}

export function listDiagrams(projectId: string): Promise<{ diagrams: Diagram[] }> {
  return request<{ diagrams: Diagram[] }>(`/api/projects/${projectId}/diagrams`);
}

export function createDiagram(projectId: string, input: DiagramInput): Promise<{ diagram: Diagram }> {
  return request<{ diagram: Diagram }>(`/api/projects/${projectId}/diagrams`, {
    method: 'POST',
    body: json(input),
  });
}

export function getDiagram(diagramId: string): Promise<{ diagram: Diagram }> {
  return request<{ diagram: Diagram }>(`/api/diagrams/${diagramId}`);
}

export function updateDiagram(
  diagramId: string,
  input: Partial<DiagramInput>,
): Promise<{ diagram: Diagram }> {
  return request<{ diagram: Diagram }>(`/api/diagrams/${diagramId}`, {
    method: 'PUT',
    body: json(input),
  });
}

/** 显式绑定命名版本（不改内容）。 */
export function bindDiagram(diagramId: string, versionId: string): Promise<{ diagram: Diagram }> {
  return request<{ diagram: Diagram }>(`/api/diagrams/${diagramId}/bind`, {
    method: 'POST',
    body: json({ versionId }),
  });
}

export async function deleteDiagram(diagramId: string): Promise<void> {
  await request<null>(`/api/diagrams/${diagramId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// P2：功能清单（FeatureSpec）
// ---------------------------------------------------------------------------

export interface FeatureInput {
  title: string;
  description?: string;
  status?: FeatureSpec['status'];
  priority?: FeatureSpec['priority'];
  chapterRef?: string | null;
  diagramId?: string | null;
}

export function listFeatures(projectId: string): Promise<{ features: FeatureSpec[] }> {
  return request<{ features: FeatureSpec[] }>(`/api/projects/${projectId}/features`);
}

export function createFeature(projectId: string, input: FeatureInput): Promise<{ feature: FeatureSpec }> {
  return request<{ feature: FeatureSpec }>(`/api/projects/${projectId}/features`, {
    method: 'POST',
    body: json(input),
  });
}

export function updateFeature(
  featureId: string,
  input: Partial<FeatureInput>,
): Promise<{ feature: FeatureSpec }> {
  return request<{ feature: FeatureSpec }>(`/api/features/${featureId}`, {
    method: 'PATCH',
    body: json(input),
  });
}

export async function deleteFeature(featureId: string): Promise<void> {
  await request<null>(`/api/features/${featureId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// P2：ImpactPlan（先展示影响，再确认执行 = 批量采纳）
// ---------------------------------------------------------------------------

export interface ImpactPlanInput {
  proposalIds?: string[];
  trigger?: string;
}

export function createImpactPlan(
  documentId: string,
  input: ImpactPlanInput = {},
): Promise<{ plan: ImpactPlan }> {
  return request<{ plan: ImpactPlan }>(`/api/documents/${documentId}/impact-plan`, {
    method: 'POST',
    body: json(input),
  });
}

export function getImpactPlan(planId: string): Promise<{ plan: ImpactPlan }> {
  return request<{ plan: ImpactPlan }>(`/api/impact-plans/${planId}`);
}

export function executeImpactPlan(
  planId: string,
  proposalIds?: string[],
): Promise<{ plan: ImpactPlan; batch: BatchAcceptResult }> {
  return request<{ plan: ImpactPlan; batch: BatchAcceptResult }>(
    `/api/impact-plans/${planId}/execute`,
    { method: 'POST', body: json({ proposalIds }) },
  );
}

// ---------------------------------------------------------------------------
// P2：批量采纳 / 导出模板
// ---------------------------------------------------------------------------

export function batchAcceptProposals(
  documentId: string,
  ids: string[],
  reviewer?: string,
): Promise<BatchAcceptResult> {
  return request<BatchAcceptResult>(`/api/documents/${documentId}/proposals/batch-accept`, {
    method: 'POST',
    body: json({ ids, reviewer }),
  });
}

export function listTemplates(): Promise<{ templates: DocumentTemplateInfo[] }> {
  return request<{ templates: DocumentTemplateInfo[] }>('/api/templates');
}
