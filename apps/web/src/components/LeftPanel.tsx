/** 左侧工作区：项目空间、引用资料、AI 对话、档位/执行器、模型状态、运行过程、故障演练。 */
import { useRef } from 'react';
import type {
  DataLevel,
  Document,
  ExecutionBackendId,
  FaultKind,
  Project,
  ProviderId,
  Reference,
  StatusResponse,
  Tier,
} from '../api/types';
import { DATA_LEVEL_LABELS, PROVIDER_LABELS, PROVIDER_OPTIONS, TIER_LABELS } from '../api/types';
import type { FaultResult, MentionSelection } from '../ui/types';
import { RunPanel, type RunPanelProps } from './RunPanel';
import { FaultPanel } from './FaultPanel';
import { ReferenceExplorer } from './ReferenceExplorer';
import { AtIcon, CloseIcon, SimulatedIcon, SparklesIcon, UploadIcon } from './Icons';
import { truncate } from '../utils/format';

export interface LeftPanelProps extends RunPanelProps {
  project: Project | null;
  projects: Project[];
  document: Document | null;
  status: StatusResponse | null;
  statusError: string | null;
  references: Reference[];
  referencesError: string | null;
  uploadingReference: boolean;
  prompt: string;
  tier: Tier;
  executor: ExecutionBackendId;
  provider: ProviderId;
  mentions: MentionSelection[];
  generating: boolean;
  onPromptChange: (value: string) => void;
  onTierChange: (tier: Tier) => void;
  onExecutorChange: (executor: ExecutionBackendId) => void;
  onProviderChange: (provider: ProviderId) => void;
  onGenerate: () => void;
  onFillExample: () => void;
  onInsertMention: (mention: MentionSelection) => void;
  onRemoveMention: (mention: MentionSelection) => void;
  onUploadReference: (file: File) => void;
  onSelectProject: (projectId: string) => void;
  onRefreshStatus: () => void;
  faultEnabled: boolean;
  faultBusy: FaultKind | null;
  faultResult: FaultResult | null;
  onFault: (fault: FaultKind) => void;
}

function providerConfiguredFlag(status: StatusResponse | null): boolean | null {
  if (!status) return null;
  return status.providers.some((provider) => provider.configured);
}

export function LeftPanel(props: LeftPanelProps) {
  const {
    project,
    projects,
    document,
    status,
    statusError,
    references,
    referencesError,
    uploadingReference,
    prompt,
    tier,
    executor,
    provider,
    mentions,
    generating,
    activeRun,
    activeKind,
    recentRuns,
    runError,
    runBusy,
    faultEnabled,
    faultBusy,
    faultResult,
    onPromptChange,
    onTierChange,
    onExecutorChange,
    onProviderChange,
    onGenerate,
    onFillExample,
    onInsertMention,
    onRemoveMention,
    onUploadReference,
    onSelectProject,
    onRefreshStatus,
    onCancelRun,
    onSelectRun,
    onRefreshRuns,
    onFault,
  } = props;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const providerConfigured = providerConfiguredFlag(status);
  const currentModel = status?.current ?? null;
  const realModelConfigured = currentModel?.realModelConfigured ?? providerConfigured;
  const providerWarning = status !== null && realModelConfigured === false && executor === 'dsh';
  const effectiveProvider: ProviderId = executor === 'mock' ? 'mock' : provider;
  const backends = status?.backends ?? [];
  const backendById = new Map(backends.map((backend) => [backend.id, backend]));
  const dataLevel: DataLevel = project?.dataLevel ?? 'internal';

  const backendOptions: Array<{ id: ExecutionBackendId; label: string; available: boolean; mock: boolean }> = [
    {
      id: 'dsh',
      label: 'DSH（真实模型）',
      available: backendById.get('dsh')?.available ?? true,
      mock: false,
    },
    {
      id: 'mock',
      label: '模拟（离线演示）',
      available: backendById.get('mock')?.available ?? true,
      mock: true,
    },
  ];
  const codex = backendById.get('codex');
  if (codex) {
    backendOptions.push({ id: 'codex', label: `Codex（${codex.available ? '可用' : '不可用'}）`, available: codex.available, mock: false });
  }

  return (
    <aside className="left-panel" data-testid="left-panel">
      {/* 项目空间 */}
      <section className="panel-section">
        <div className="section-head">
          <h3>项目空间</h3>
          <span className={`level-badge level-${dataLevel}`} data-testid="left-data-level">
            {DATA_LEVEL_LABELS[dataLevel]}
          </span>
        </div>
        <div className="project-card">
          <div className="project-card-name" title={project?.name}>
            {project?.name ?? '未选择项目'}
          </div>
          {project?.description ? <p className="project-card-desc">{project.description}</p> : null}
          <div className="project-card-meta">
            <span title="当前文档 revision">rev {document?.revision ?? '—'}</span>
            <span title="服务端派生段落块数量">{document?.paragraphs.length ?? 0} 段</span>
            <span title="文档标题">{truncate(document?.title ?? '—', 24)}</span>
          </div>
          {dataLevel === 'secret' ? (
            <p className="project-card-warning">机密项目：真实模型外发会被服务端阻断（data_policy_blocked）。</p>
          ) : null}
        </div>
        {projects.length > 1 ? (
          <div className="project-switch">
            <span className="project-switch-label">切换项目</span>
            <ul>
              {projects.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`project-switch-item${item.id === project?.id ? ' is-active' : ''}`}
                    onClick={() => onSelectProject(item.id)}
                    title={item.description || item.name}
                  >
                    {item.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* 引用资料 */}
      <section className="panel-section" data-testid="reference-section">
        <div className="section-head">
          <h3>
            引用资料
            <span className="section-sub">{references.length} 份</span>
          </h3>
          <div className="section-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx,.md,.txt"
              className="hidden-input"
              data-testid="reference-file-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUploadReference(file);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="icon-btn"
              title="上传引用资料（.docx / .md / .txt，≤10MB）"
              aria-label="上传引用资料"
              data-testid="btn-upload-reference"
              disabled={uploadingReference || !project}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingReference ? <span className="spinner spinner-sm" /> : <UploadIcon size={14} />}
            </button>
          </div>
        </div>
        <ReferenceExplorer
          projectId={project?.id ?? null}
          references={references}
          referencesError={referencesError}
          selectedSectionIds={mentions.flatMap((mention) => (mention.sectionId ? [mention.sectionId] : []))}
          selectedReferenceIds={mentions.map((mention) => mention.referenceId)}
          onInsertMention={onInsertMention}
        />
      </section>

      {/* AI 对话 / 生成 */}
      <section className="panel-section composer" data-testid="composer">
        <div className="section-head">
          <h3>AI 对话</h3>
          <button type="button" className="btn btn-tiny" data-testid="btn-fill-example" onClick={onFillExample}>
            填入示例
          </button>
        </div>
        <textarea
          className="prompt-input"
          data-testid="prompt-input"
          value={prompt}
          rows={4}
          placeholder="例：引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议"
          onChange={(event) => onPromptChange(event.target.value)}
        />
        {mentions.length > 0 ? (
          <div className="mention-chips" data-testid="mention-chips">
            <span className="mention-chips-label">
              已选引用 {mentions.length} 项（随生成发送 referenceIds/referenceSectionIds）
            </span>
            <ul>
              {mentions.map((mention) => (
                <li key={mention.sectionId ?? mention.referenceId} className="mention-chip" data-testid="mention-chip">
                  <AtIcon size={11} />
                  <span className="mention-chip-text" title={`${mention.referenceTitle}${mention.locator ? ` · ${mention.locator}` : ''}`}>
                    {truncate(mention.referenceTitle, 18)}
                    {mention.locator ? ` · ${truncate(mention.locator, 22)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="mention-chip-remove"
                    aria-label="移除引用"
                    data-testid="btn-remove-mention"
                    onClick={() => onRemoveMention(mention)}
                  >
                    <CloseIcon size={10} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="composer-hint">
          可 @ 引用左侧资料（可展开小节或搜索定位）；AI 只提交建议，不直接改正文。生成 5 条建议。
        </div>
        <div className="composer-row">
          <label className="field">
            <span className="field-label">逻辑档位</span>
            <select
              className="select"
              data-testid="tier-select"
              value={tier}
              onChange={(event) => onTierChange(event.target.value as Tier)}
            >
              {(['draft', 'review', 'long_reasoning'] as const).map((item) => (
                <option key={item} value={item}>
                  {TIER_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">执行器</span>
            <select
              className="select"
              data-testid="backend-select"
              value={executor}
              onChange={(event) => onExecutorChange(event.target.value as ExecutionBackendId)}
            >
              {backendOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">模型提供方</span>
            <select
              className="select"
              data-testid="provider-select"
              value={effectiveProvider}
              disabled={executor === 'mock'}
              title={executor === 'mock' ? '模拟执行器强制使用 Mock provider' : '选择真实模型提供方（随 generate/discuss 发送）'}
              onChange={(event) => onProviderChange(event.target.value as ProviderId)}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {effectiveProvider === 'mock' ? (
          <div className="mock-note" data-testid="mock-note">
            <SimulatedIcon size={14} />
            当前为<strong>模拟（Mock）</strong>
            {executor === 'mock' ? '执行器' : 'provider'}：离线确定性生成 5 条建议，用于本机演示，
            <strong>不代表真实模型输出</strong>。
          </div>
        ) : null}
        {providerWarning ? (
          <div className="provider-warning" data-testid="provider-warning">
            <strong>真实模型未配置凭据。</strong> 直接生成会返回 credential_missing；可切换为模拟执行器完成演示。
            <button type="button" className="btn btn-tiny" data-testid="btn-use-mock" onClick={() => onExecutorChange('mock')}>
              改用模拟
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-generate"
          data-testid="btn-generate"
          onClick={onGenerate}
          disabled={generating || runBusy || !document}
        >
          {generating || runBusy ? <span className="spinner spinner-sm spinner-light" /> : <SparklesIcon size={15} />}
          {generating || runBusy ? '生成中…' : '生成建议'}
        </button>
        {!runBusy && activeRun?.status === 'failed' && runError ? (
          <p className="inline-error">上次运行失败：{runError.code}</p>
        ) : null}
      </section>

      {/* 模型与执行器状态 */}
      <section className="panel-section" data-testid="model-status">
        <div className="section-head">
          <h3>模型与执行器状态</h3>
          <button type="button" className="icon-btn" data-testid="btn-refresh-status" title="刷新状态" aria-label="刷新状态" onClick={onRefreshStatus}>
            <SparklesIcon size={13} />
          </button>
        </div>
        {statusError ? (
          <p className="inline-error">状态接口不可用：{statusError}</p>
        ) : status === null ? (
          <p className="section-empty">正在读取服务端配置…</p>
        ) : (
          <>
            <div className="status-group">
              <span className="status-group-label">当前模型链路</span>
              {currentModel ? (
                <div className="current-model" data-testid="current-model" data-mock={currentModel.providerId === 'mock' ? 'true' : 'false'}>
                  <div className="current-model-line">
                    <span className="current-model-provider">
                      {currentModel.providerLabel || PROVIDER_LABELS[currentModel.providerId as ProviderId] || currentModel.providerId}
                    </span>
                    {currentModel.providerId === 'mock' ? (
                      <span className="pill pill-mock" data-testid="current-model-mock">
                        <SimulatedIcon size={11} />
                        模拟
                      </span>
                    ) : null}
                    <span className={`pill ${currentModel.realModelConfigured ? 'status-ok' : 'status-danger'}`}>
                      {currentModel.realModelConfigured ? '真实模型凭据已配置' : '真实模型未配置'}
                    </span>
                  </div>
                  <div className="current-model-meta">
                    <span data-testid="current-model-name" title="模型">
                      模型 <code>{currentModel.model || '—'}</code>
                    </span>
                    <span data-testid="current-model-timeout" title="模型超时">
                      模型超时 {currentModel.modelTimeoutMs} ms
                    </span>
                    <span data-testid="current-model-watchdog" title="看门狗超时">
                      看门狗 {currentModel.watchdogTimeoutMs} ms
                    </span>
                  </div>
                  <div className="current-model-meta">
                    <span>执行器 {currentModel.backend}</span>
                    <span>提供方 {currentModel.providerId}</span>
                  </div>
                </div>
              ) : (
                <p className="section-empty" data-testid="current-model-missing">
                  服务端尚未返回 current（P1 扩展接口未就绪）；生成时仍会按所选 provider 发送。
                </p>
              )}
            </div>
            <div className="status-group">
              <span className="status-group-label">远端模型提供方</span>
              {status.providers.length === 0 ? (
                <p className="section-empty">无可用提供方。</p>
              ) : (
                <ul className="status-list">
                  {status.providers.map((provider) => (
                    <li key={provider.id} className="status-item">
                      <span className="status-item-name" title={provider.note}>
                        {provider.label}
                        {provider.current ? (
                          <span className="pill pill-current" data-testid="provider-current-badge">
                            当前
                          </span>
                        ) : null}
                      </span>
                      <span className={`pill ${provider.configured ? 'status-ok' : 'status-muted'}`}>
                        {provider.configured ? '已配置' : '未配置'}
                      </span>
                      {provider.models.length > 0 ? (
                        <span className="status-item-detail" title={provider.models.join(', ')}>
                          {provider.models[0]}
                        </span>
                      ) : null}
                      {provider.blockedByDataPolicy ? <span className="pill pill-warn">数据分级阻断</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="status-group">
              <span className="status-group-label">执行器</span>
              <ul className="status-list">
                {backends.length === 0 ? (
                  <li className="status-item">
                    <span className="status-item-name">状态未知（接口未返回）</span>
                  </li>
                ) : (
                  backends.map((backend) => (
                    <li key={backend.id} className="status-item">
                      <span className="status-item-name">
                        {backend.label}
                        {backend.mock ? (
                          <span className="pill pill-mock" data-testid="mock-badge">
                            模拟
                          </span>
                        ) : null}
                      </span>
                      <span className={`pill ${backend.available ? 'status-ok' : 'status-danger'}`}>
                        {backend.available ? '可用' : '不可用'}
                      </span>
                      {backend.reason ? (
                        <span className="status-item-detail" title={backend.reason}>
                          {backend.reason}
                        </span>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div className="status-group">
              <span className="status-group-label">数据分级策略</span>
              <p className="status-policy">
                允许外发档位：{status.dataPolicy.externalProvidersAllowedFor.map((level) => DATA_LEVEL_LABELS[level]).join(' / ')}
                ；机密级一律阻断。
              </p>
            </div>
          </>
        )}
      </section>

      <RunPanel
        activeRun={activeRun}
        activeKind={activeKind}
        recentRuns={recentRuns}
        runError={runError}
        runBusy={runBusy}
        onCancelRun={onCancelRun}
        onSelectRun={onSelectRun}
        onRefreshRuns={onRefreshRuns}
      />

      <FaultPanel
        enabled={faultEnabled}
        busy={faultBusy}
        result={faultResult}
        providerConfigured={providerConfigured}
        onFault={onFault}
      />
    </aside>
  );
}
