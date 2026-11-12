/**
 * YXworker P0 领域类型（服务端权威定义）。
 *
 * 约定：本文件是前后端 API 契约的单一来源；前端在
 * `apps/web/src/api/types.ts` 保留同构副本，修改时同步。
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
  /** P1：已切分的小节/段落数量（@ 定位与来源打开使用）。 */
  sectionCount?: number;
  createdAt: string;
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
  /** P1：是否为当前默认 provider。 */
  current?: boolean;
  baseUrl: string | null;
  models: string[];
  /** 可用于哪些逻辑档位；空数组表示不可用 */
  tiers: string[];
  blockedByDataPolicy: boolean;
  note: string;
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

/** P1：当前默认执行器/模型与超时上限（/api/status 展示）。 */
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
  current?: CurrentModelStatus | null;
  providers: ProviderStatus[];
  backends: BackendStatus[];
  dataPolicy: DataPolicyInfo;
  faultInjectionEnabled: boolean;
  features: Record<string, boolean>;
  limits: Record<string, string>;
}

/* ============================ P1/P2 类型扩展 ============================ */

/** 引用资料的逻辑小节/段落定位（@ 引用与来源打开使用）。 */
export interface ReferenceSection {
  id: string;
  referenceId: string;
  /** 人类可读定位，如「第 2 节 试点范围 / 第 3 段」。 */
  locator: string;
  sectionTitle: string;
  paragraphIndex: number;
  /** 片段（≤300 字），用于检索结果与卡片展示。 */
  excerpt: string;
  /** 该段完整文本，用于“打开来源”在原文中定位/高亮。 */
  content: string;
  createdAt: string;
}

/** @ 检索结果：引用 + locator + excerpt。 */
export interface ReferenceLocatorResult {
  referenceId: string;
  referenceTitle: string;
  sectionId: string;
  locator: string;
  excerpt: string;
}

/** Mermaid 图表（P2）：源码 + 版本绑定。 */
export interface Diagram {
  id: string;
  projectId: string;
  title: string;
  kind: string;
  source: string;
  description: string;
  documentId: string | null;
  /** 绑定的文档 revision（保存/绑定时记录）。 */
  documentRevision: number | null;
  /** 绑定的命名版本名（如 V1.0/V1.1），可为空。 */
  versionName: string | null;
  /** 关联章节标题（ImpactPlan 用）。 */
  chapterRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 功能清单条目（P2 FeatureSpec）。 */
export type FeatureStatus = 'planned' | 'in_progress' | 'done' | 'dropped';

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

export interface DocumentTemplateInfo {
  id: 'gov' | 'tech';
  name: string;
  description: string;
}
