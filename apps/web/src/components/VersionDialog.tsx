/** 版本历史弹窗：列表、创建命名版本、只读查看、回退确认、导出指定版本。 */
import { useEffect, useMemo, useState } from 'react';
import type { Version } from '../api/types';
import { ReadonlyEditor } from '../editor/EditorPane';
import { DownloadIcon, HistoryIcon, PlusIcon, RefreshIcon, UndoIcon } from './Icons';
import { formatDateTime } from '../utils/format';

export interface VersionDialogProps {
  open: boolean;
  /** 打开时希望定位到的版本 id（顶部版本下拉选择时使用）。 */
  initialVersionId?: string | null;
  versions: Version[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onCreate: (name: string) => void;
  onRestore: (versionId: string) => void;
  onExportVersion: (versionId: string) => void;
}

export function VersionDialog({
  open,
  initialVersionId = null,
  versions,
  loading,
  busy,
  error,
  onClose,
  onRefresh,
  onCreate,
  onRestore,
  onExportVersion,
}: VersionDialogProps) {
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmRestoreId(null);
      return;
    }
    setSelectedId((current) => {
      if (initialVersionId && versions.some((version) => version.id === initialVersionId)) {
        return initialVersionId;
      }
      if (current && versions.some((version) => version.id === current)) return current;
      return versions.length > 0 ? versions[versions.length - 1].id : null;
    });
  }, [open, versions, initialVersionId]);

  const selected = useMemo(
    () => versions.find((version) => version.id === selectedId) ?? null,
    [versions, selectedId],
  );

  if (!open) return null;

  const handleCreate = () => {
    const value = name.trim();
    if (!value) return;
    onCreate(value);
    setName('');
  };

  return (
    <div
      className="modal-overlay"
      data-testid="version-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal version-dialog" role="dialog" aria-modal="true" aria-label="版本历史" data-testid="version-dialog">
        <header className="modal-head">
          <div className="modal-title">
            <HistoryIcon size={17} />
            <h2>版本历史</h2>
            <span className="count-badge">{versions.length}</span>
          </div>
          <div className="modal-head-actions">
            <button type="button" className="icon-btn" title="刷新版本列表" aria-label="刷新版本列表" onClick={onRefresh} disabled={loading}>
              <RefreshIcon size={14} />
            </button>
            <button type="button" className="icon-btn" title="关闭" aria-label="关闭版本历史" data-testid="btn-version-close" onClick={onClose}>
              ×
            </button>
          </div>
        </header>

        <div className="version-create">
          <input
            className="input"
            data-testid="version-name-input"
            value={name}
            placeholder="版本名（如 V1.1）"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleCreate();
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="btn-create-version"
            disabled={busy || name.trim().length === 0}
            onClick={handleCreate}
          >
            <PlusIcon size={14} />
            创建命名版本
          </button>
          <span className="version-create-hint">保存当前正文快照；不影响历史版本。</span>
        </div>

        {error ? <p className="inline-error modal-error">{error}</p> : null}

        <div className="version-body">
          <div className="version-list" data-testid="version-list">
            {loading && versions.length === 0 ? (
              <div className="version-empty">
                <span className="spinner" />
                正在加载版本…
              </div>
            ) : versions.length === 0 ? (
              <div className="version-empty">暂无命名版本。创建后会出现在这里。</div>
            ) : (
              versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  className={`version-item${version.id === selectedId ? ' is-active' : ''}`}
                  data-testid="version-item"
                  data-version-id={version.id}
                  onClick={() => {
                    setSelectedId(version.id);
                    setConfirmRestoreId(null);
                  }}
                >
                  <span className="version-name">{version.name}</span>
                  <span className="version-meta">rev {version.revision}</span>
                  <span className="version-time">{formatDateTime(version.createdAt)}</span>
                </button>
              ))
            )}
          </div>

          <div className="version-preview">
            {selected ? (
              <>
                <div className="version-preview-head">
                  <div>
                    <h3>{selected.name}</h3>
                    <p>
                      revision {selected.revision} · {formatDateTime(selected.createdAt)} · {selected.createdBy || '本机'}
                    </p>
                  </div>
                  <div className="version-preview-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      data-testid="btn-version-export"
                      disabled={busy}
                      onClick={() => onExportVersion(selected.id)}
                    >
                      <DownloadIcon size={13} />
                      导出该版本
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      data-testid="btn-version-restore"
                      disabled={busy}
                      onClick={() => setConfirmRestoreId(selected.id)}
                    >
                      <UndoIcon size={13} />
                      回退到此版本
                    </button>
                  </div>
                </div>

                {confirmRestoreId === selected.id ? (
                  <div className="version-confirm" data-testid="version-restore-confirm">
                    <p>
                      确认回退到 <strong>{selected.name}</strong>？将以该版本内容生成新的 revision，不删除历史版本。
                    </p>
                    <div className="version-confirm-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-xs"
                        data-testid="btn-version-confirm-restore"
                        disabled={busy}
                        onClick={() => {
                          onRestore(selected.id);
                          setConfirmRestoreId(null);
                        }}
                      >
                        确认回退
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setConfirmRestoreId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="version-preview-doc">
                  <ReadonlyEditor key={selected.id} content={selected.contentJson} />
                </div>
              </>
            ) : (
              <div className="version-empty">选择左侧版本以只读查看内容。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
