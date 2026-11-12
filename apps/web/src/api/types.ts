/**
 * YXworker P0 领域类型（前端同构副本）。
 *
 * 权威定义：`apps/server/src/types.ts`；本文件只做前端镜像，修改时须同步。
 * 契约：`docs/API_CONTRACT.md`。
 */

export type DataLevel = 'public' | 'internal' | 'secret';

export interface Project {
  id: string;
  name: string;
  description: string;
  dataLevel: DataLevel;
  documentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  projectId: string;
  title: string;
  revision: number;
  paragraphCount: number;
  updatedAt: string;
}

/** 由 ProseMirror/TipTap JSON 派生出的稳定段落块（服务端计算）。 */
export interface ParagraphBlock {
  id: string;
  index: number;
  /** 块类型：正文、标题、列表项、引用。 */
  type: 'paragraph' | 'heading' | 'listItem' | 'blockquote';
  /** 标题层级（仅 heading）。 */
  level?: number;
  /** 列表类型（仅 listItem）。 */
  listKind?: 'bulletList' | 'orderedList';
  /** 纯文本（不含标记符）。 */
  text: string;
  /** 段落纯文本的 SHA-256，用于冲突检测/安全重基。 */
  hash: string;
  /** 所在章节序号（从 0 开始）；标题块自身归属于它开启的章节。 */
  chapterIndex: number;
  chapterTitle: string;
}

export interface Document {
  id: string;
  projectId: string;
  title: string;
  revision: number;
  /** TipTap/ProseMirror JSON。 */
  contentJson: unknown;
  paragraphs: ParagraphBlock[];
  updatedAt: string;
}

export type ProposalStatus =
  | 'proposed'
  | 'revised'
  | 'accepted'
  | 'rejected'
  | 'conflicted';

export interface Citation {
  referenceId: string;
  title: string;
  locator: string;
  excerpt: string;
}

export interface Proposal {
  id: string;
  documentId: string;
  runId: string | null;
  status: ProposalStatus;
  paragraphId: string;
  paragraphIndex: number;
  chapterTitle: string;
  /** 生成建议时的目标段落原文。 */
  quote: string;
  oldText: string;
  newText: string;
  reason: string;
  citations: Citation[];
  model: string;
  provider: string;
  backend: string;
  tier: string;
  baseRevision: number;
  baseHash: string;
  discussionCount: number;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  reviewer: string | null;
  conflictReason: string | null;
}

export interface ProposalEvent {
  id: string;
  proposalId: string;
  fromStatus: ProposalStatus | null;
  toStatus: ProposalStatus;
  actor: string;
  note: string;
  at: string;
}

export interface Reference {
  id: string;
  projectId: string;
  title: string;
  kind: 'docx' | 'md' | 'txt';
  filename: string;
  charCount: number;
  excerpt: string;
  createdAt: string;
  /** P1：服务端切分出的逻辑小节/段落数量（可能为 undefined：旧数据或接口未就绪）。 */
  sectionCount?: number;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunType = 'proposal_generation' | 'discussion';

export interface RunError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RunEvent {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface Run {
  id: string;
  projectId: string;
  documentId: string;
  type: RunType;
  status: RunStatus;
  backend: string;
  provider: string;
  model: string;
  tier: string;
  prompt: string;
  error: RunError | null;
  events: RunEvent[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  retryReason: string | null;
  fallbackFrom: string | null;
  dataPolicyId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Version {
  id: string;
  documentId: string;
  name: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  contentJson: unknown;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  baseUrl: string | null;
  models: string[];
  /** 可用于哪些逻辑档位；空数组表示不可用 */
  tiers: string[];
  blockedByDataPolicy: boolean;
  note: string;
  /** P1：是否为当前默认 provider（契约扩展）。 */
  current?: boolean;
}

export interface BackendStatus {
  id: string;
  label: string;
  available: boolean;
  /** 是否为模拟执行器；模拟结果必须在 UI 明确标注“模拟”。 */
  mock: boolean;
  reason: string;
}

export interface DataPolicyInfo {
  defaultLevel: DataLevel;
  externalProvidersAllowedFor: DataLevel[];
  note: string;
}

/** P1：当前生效的模型链路（契约 §P1-3；旧版后端可能不返回，故为可选）。 */
export interface CurrentModelStatus {
  backend: string;
  providerId: string;
  providerLabel: string;
  providerKind?: string;
  model: string;
  modelTimeoutMs: number;
  watchdogTimeoutMs: number;
  realModelConfigured: boolean;
}

export interface StatusResponse {
  app: { name: string; version: string; mockMode: boolean };
  providers: ProviderStatus[];
  backends: BackendStatus[];
  dataPolicy: DataPolicyInfo;
  faultInjectionEnabled: boolean;
  features: Record<string, boolean>;
  limits: Record<string, string>;
  /** P1：当前 provider/model/超时；服务端 P1 扩展后提供。 */
  current?: CurrentModelStatus | null;
}

/** 编辑器/界面共用的逻辑档位（API 契约 §4）。 */
export type Tier = 'draft' | 'review' | 'long_reasoning';
export type ExecutionBackendId = 'dsh' | 'mock' | 'codex';
export type FaultKind = 'rate_limit' | 'server_error' | 'network' | 'timeout' | 'data_policy';

export const TIER_LABELS: Record<Tier, string> = {
  draft: '草稿',
  review: '审阅',
  long_reasoning: '长推理',
};

export const DATA_LEVEL_LABELS: Record<DataLevel, string> = {
  public: '公开',
  internal: '内部',
  secret: '机密',
};

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  proposed: '待审',
  revised: '修订中',
  accepted: '已采纳',
  rejected: '已拒绝',
  conflicted: '冲突',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/* ============================ P1/P2 类型扩展 ============================ */

/** P1：模型提供方三选（openai 兼容网关 / DeepSeek Anthropic 协议 / 模拟）。 */
export type ProviderId = 'openai-compatible' | 'deepseek-anthropic' | 'mock';

/** P1：引用资料的逻辑小节/段落定位（@ 引用与来源打开使用）。 */
export interface ReferenceSection {
  id: string;
  referenceId: string;
  /** 人类可读定位，如「第 2 节 试点范围 / 第 3 段」。 */
  locator: string;
  sectionTitle: string;
  paragraphIndex: number;
  /** 片段（≤300 字）。 */
  excerpt: string;
  /** 该段完整文本，用于“打开来源”在原文中定位/高亮。 */
  content: string;
  createdAt: string;
}

/** P1：@ 检索结果（引用 + locator + excerpt）。 */
export interface ReferenceLocatorResult {
  referenceId: string;
  referenceTitle: string;
  sectionId: string;
  locator: string;
  excerpt: string;
}

/** P2：Mermaid 图表（源码 + 版本绑定）。 */
export interface Diagram {
  id: string;
  projectId: string;
  title: string;
  kind: string;
  source: string;
  description: string;
  documentId: string | null;
  documentRevision: number | null;
  versionName: string | null;
  chapterRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FeatureStatus = 'planned' | 'in_progress' | 'done' | 'dropped';

/** P2：功能清单条目。 */
export interface FeatureSpec {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: FeatureStatus;
  priority: 'P0' | 'P1' | 'P2';
  chapterRef: string | null;
  diagramId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImpactAffectedChapter {
  chapterIndex: number;
  chapterTitle: string;
  paragraphIds: string[];
  paragraphCount: number;
}

export interface ImpactAffectedDiagrams {
  diagram: Diagram;
  reason: string;
}

export interface ImpactAffectedFeatures {
  feature: FeatureSpec;
  reason: string;
}

/** P2：影响分析计划（先展示影响，再逐项执行）。 */
export interface ImpactPlan {
  id: string;
  documentId: string;
  baseRevision: number;
  trigger: string;
  affected: {
    chapters: ImpactAffectedChapter[];
    proposals: Proposal[];
    diagrams: ImpactAffectedDiagrams[];
    featureSpecs: ImpactAffectedFeatures[];
  };
  createdAt: string;
  executedAt: string | null;
}

export interface BatchAcceptItemResult {
  id: string;
  ok: boolean;
  status: ProposalStatus | null;
  error: string | null;
}

export interface BatchAcceptResult {
  results: BatchAcceptItemResult[];
  document: Document;
}

/** P2：Word 导出模板（gov 政务公文 / tech 技术方案）。 */
export interface DocumentTemplateInfo {
  id: 'gov' | 'tech';
  name: string;
  description: string;
}

/* --------------------------- 展示层标签常量 --------------------------- */

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'openai-compatible': 'OpenAI 兼容网关',
  'deepseek-anthropic': 'DeepSeek（Anthropic 协议）',
  mock: '模拟（Mock）',
};

export const PROVIDER_OPTIONS: Array<{ id: ProviderId; label: string }> = [
  { id: 'openai-compatible', label: PROVIDER_LABELS['openai-compatible'] },
  { id: 'deepseek-anthropic', label: PROVIDER_LABELS['deepseek-anthropic'] },
  { id: 'mock', label: PROVIDER_LABELS.mock },
];

export const DIAGRAM_KIND_LABELS: Record<string, string> = {
  flowchart: '流程图',
  architecture: '架构图',
  sequence: '时序图',
  class: '类图',
  state: '状态图',
};

export const DIAGRAM_KINDS = ['flowchart', 'architecture', 'sequence', 'class', 'state'] as const;

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  planned: '计划中',
  in_progress: '进行中',
  done: '已完成',
  dropped: '已放弃',
};

export const FEATURE_STATUS_OPTIONS: FeatureStatus[] = ['planned', 'in_progress', 'done', 'dropped'];

export const PRIORITY_OPTIONS: Array<'P0' | 'P1' | 'P2'> = ['P0', 'P1', 'P2'];

export const TEMPLATE_OPTIONS: Array<{ id: 'gov' | 'tech'; label: string; hint: string }> = [
  { id: 'tech', label: '技术方案（tech）', hint: '微软雅黑标题、1.5 倍行距' },
  { id: 'gov', label: '政务公文（gov）', hint: '小标宋标题、仿宋正文、公文页边距' },
];
