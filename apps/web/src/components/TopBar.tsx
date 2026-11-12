/** 顶部栏：项目名、版本、保存状态、版本历史、导出 Word、数据分级、执行器标识。 */
import type { DataLevel, Document, ExecutionBackendId, Project, StatusResponse, Version } from '../api/types';
import { DATA_LEVEL_LABELS, TEMPLATE_OPTIONS } from '../api/types';
import type { SaveState } from '../ui/types';
import { AlertIcon, CheckIcon, ChevronDownIcon, DownloadIcon, HistoryIcon } from './Icons';

function SaveStateIcon({ state, size = 14 }: { state: SaveState; size?: number }) {
  if (state === 'saving') return <span className="spinner spinner-sm" aria-hidden="true" />;
  if (state === 'error' || state === 'conflict') return <AlertIcon size={size} />;
  if (state === 'dirty') return <span className="dot dot-amber" aria-hidden="true" />;
  return <CheckIcon size={size} />;
}

export interface TopBarProps {
  project: Project | null;
  document: Document | null;
  versions: Version[];
  saveState: SaveState;
  saveError: string | null;
  executor: ExecutionBackendId;
  tierLabel?: string;
  status: StatusResponse | null;
  exporting: boolean;
  dataLevelBusy: boolean;
  exportTemplate: 'gov' | 'tech';
  onOpenVersions: () => void;
  onExport: () => void;
  onPreviewVersion: (versionId: string) => void;
  onChangeDataLevel: (level: DataLevel) => void;
  onChangeExportTemplate: (template: 'gov' | 'tech') => void;
}

const SAVE_LABELS: Record<SaveState, string> = {
  idle: '已保存',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
  conflict: '版本冲突，已刷新',
};

export function TopBar({
  project,
  document,
  versions,
  saveState,
  saveError,
  executor,
  tierLabel,
  status,
  exporting,
  dataLevelBusy,
  exportTemplate,
  onOpenVersions,
  onExport,
  onPreviewVersion,
  onChangeDataLevel,
  onChangeExportTemplate,
}: TopBarProps) {
  const latestVersion = versions.length > 0 ? versions[versions.length - 1] : null;
  const mockMode = status?.app.mockMode === true || executor === 'mock';
  const dataLevel: DataLevel = project?.dataLevel ?? 'internal';
  const saveTitle = saveError ?? SAVE_LABELS[saveState];

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-brand">
        <div className="brand-mark" aria-hidden="true">
          YX
        </div>
        <div className="brand-text">
          <span className="brand-name">YXworker</span>
          <span className="brand-sub">AI 项目方案工作台</span>
        </div>
      </div>

      <div className="topbar-divider" />

      <div className="topbar-project">
        <div className="project-line">
          <span className="project-name" data-testid="topbar-project-name" title={project?.name}>
            {project?.name ?? '未选择项目'}
          </span>
          <span className="version-chip" data-testid="version-chip" title="当前命名版本 / 文档 revision">
            {latestVersion ? latestVersion.name : 'V1.0'}
            <span className="version-rev">rev {document?.revision ?? '—'}</span>
          </span>
        </div>
        <span className="project-doc-title" title={document?.title}>
          {document?.title ?? '正在加载文档…'}
        </span>
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-actions">
        <label className="topbar-field" title="查看历史版本（只读预览 / 回退）">
          <select
            className="select select-version"
            data-testid="version-select"
            value=""
            onChange={(event) => {
              const versionId = event.target.value;
              if (versionId) onPreviewVersion(versionId);
            }}
          >
            <option value="">版本历史（{versions.length}）</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name} · rev {version.revision}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="select-arrow" />
        </label>

        <span
          className={`save-status save-${saveState}`}
          data-testid="save-status"
          data-state={saveState}
          title={saveTitle}
        >
          <SaveStateIcon state={saveState} size={14} />
          <span className="save-label">{SAVE_LABELS[saveState]}</span>
        </span>

        <button type="button" className="btn btn-ghost" data-testid="btn-versions" onClick={onOpenVersions}>
          <HistoryIcon size={15} />
          版本历史
        </button>

        <label className="topbar-field" title="Word 导出模板（只影响版式，不改正文）">
          <select
            className="select select-template"
            data-testid="template-select"
            value={exportTemplate}
            onChange={(event) => onChangeExportTemplate(event.target.value as 'gov' | 'tech')}
          >
            {TEMPLATE_OPTIONS.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="select-arrow" />
        </label>

        <button
          type="button"
          className="btn btn-ghost"
          data-testid="btn-export"
          onClick={onExport}
          disabled={exporting || !document}
          title={`导出当前文档为 Word（.docx，模板 ${exportTemplate}）`}
        >
          <DownloadIcon size={15} />
          {exporting ? '导出中…' : '导出 Word'}
        </button>

        <label className={`topbar-field data-level-field level-${dataLevel}`} title="数据分级（本机演示：机密级禁止发送外部模型）">
          <span className="topbar-field-label">数据分级</span>
          <select
            className="select select-level"
            data-testid="data-level-select"
            value={dataLevel}
            disabled={dataLevelBusy || !project}
            onChange={(event) => onChangeDataLevel(event.target.value as DataLevel)}
          >
            {(['public', 'internal', 'secret'] as const).map((level) => (
              <option key={level} value={level}>
                {DATA_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="select-arrow" />
        </label>

        <span
          className={`executor-chip${mockMode ? ' is-mock' : ' is-real'}`}
          data-testid="executor-badge"
          data-mock={mockMode ? 'true' : 'false'}
          title={
            mockMode
              ? '当前使用模拟执行器：所有建议均为离线模拟数据（非真实模型）'
              : '当前使用 DSH 执行器链路（真实模型网关）'
          }
        >
          <span className="executor-dot" />
          {mockMode ? '模拟' : 'DSH（真实模型）'}
          {status?.current && !mockMode ? (
            <span className="executor-provider" data-testid="provider-current-label" title={`provider=${status.current.providerId} · model=${status.current.model}`}>
              · {status.current.providerLabel} · {status.current.model}
            </span>
          ) : null}
          {tierLabel ? <span className="executor-tier">· {tierLabel}</span> : null}
        </span>
      </div>
    </header>
  );
}
