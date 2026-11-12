/**
 * P2 功能清单面板（FeatureSpec CRUD）：标题/说明/状态/优先级/关联章节。
 * 服务端接口未就绪时展示可读错误，其余工作台功能不受影响。
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api/client';
import { errorMessage, isApiError } from '../api/client';
import type { FeatureSpec, FeatureStatus } from '../api/types';
import {
  FEATURE_STATUS_LABELS,
  FEATURE_STATUS_OPTIONS,
  PRIORITY_OPTIONS,
} from '../api/types';
import { CheckIcon, CloseIcon, EditIcon, FeatureListIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons';

export interface FeaturePanelProps {
  projectId: string | null;
  chapters: string[];
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

interface FeatureDraft {
  title: string;
  description: string;
  status: FeatureStatus;
  priority: 'P0' | 'P1' | 'P2';
  chapterRef: string;
}

const EMPTY_DRAFT: FeatureDraft = {
  title: '',
  description: '',
  status: 'planned',
  priority: 'P1',
  chapterRef: '',
};

function codePrefix(error: unknown): string {
  return isApiError(error) ? `[${error.code}] ` : '';
}

export function FeaturePanel({ projectId, chapters, onToast }: FeaturePanelProps) {
  const [features, setFeatures] = useState<FeatureSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<FeatureDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<FeatureDraft>(EMPTY_DRAFT);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadFeatures = useCallback(async () => {
    if (!projectId) {
      setFeatures([]);
      return;
    }
    setLoading(true);
    try {
      const { features: list } = await api.listFeatures(projectId);
      setFeatures(list);
      setListError(null);
    } catch (error) {
      setFeatures([]);
      setListError(`${codePrefix(error)}${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setAddOpen(false);
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setFormError(null);
    void loadFeatures();
  }, [loadFeatures]);

  function patchDraft(patch: Partial<FeatureDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function patchEditDraft(patch: Partial<FeatureDraft>): void {
    setEditDraft((current) => ({ ...current, ...patch }));
  }

  async function handleAdd(): Promise<void> {
    if (!projectId) return;
    const title = draft.title.trim();
    if (!title) {
      setFormError('请填写功能标题。');
      return;
    }
    setBusyId('__add__');
    setFormError(null);
    try {
      await api.createFeature(projectId, {
        title,
        description: draft.description,
        status: draft.status,
        priority: draft.priority,
        chapterRef: draft.chapterRef.trim() || null,
      });
      setDraft(EMPTY_DRAFT);
      setAddOpen(false);
      await loadFeatures();
      onToast(`功能「${title}」已添加。`, 'success');
    } catch (error) {
      setFormError(`${codePrefix(error)}${errorMessage(error)}`);
      onToast(`添加功能失败：${errorMessage(error)}`, 'error');
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(feature: FeatureSpec): void {
    setEditingId(feature.id);
    setEditDraft({
      title: feature.title,
      description: feature.description,
      status: feature.status,
      priority: feature.priority,
      chapterRef: feature.chapterRef ?? '',
    });
    setFormError(null);
    setConfirmDeleteId(null);
  }

  async function handleSaveEdit(feature: FeatureSpec): Promise<void> {
    const title = editDraft.title.trim();
    if (!title) {
      setFormError('请填写功能标题。');
      return;
    }
    setBusyId(feature.id);
    setFormError(null);
    try {
      const { feature: updated } = await api.updateFeature(feature.id, {
        title,
        description: editDraft.description,
        status: editDraft.status,
        priority: editDraft.priority,
        chapterRef: editDraft.chapterRef.trim() || null,
      });
      setFeatures((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(null);
      onToast(`功能「${title}」已更新。`, 'success');
    } catch (error) {
      setFormError(`${codePrefix(error)}${errorMessage(error)}`);
      onToast(`更新功能失败：${errorMessage(error)}`, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleQuickStatus(feature: FeatureSpec, status: FeatureStatus): Promise<void> {
    setBusyId(feature.id);
    try {
      const { feature: updated } = await api.updateFeature(feature.id, { status });
      setFeatures((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      onToast(`更新状态失败：${errorMessage(error)}`, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(feature: FeatureSpec): Promise<void> {
    setBusyId(feature.id);
    try {
      await api.deleteFeature(feature.id);
      setConfirmDeleteId(null);
      if (editingId === feature.id) setEditingId(null);
      setFeatures((prev) => prev.filter((item) => item.id !== feature.id));
      onToast(`功能「${feature.title}」已删除。`, 'success');
    } catch (error) {
      onToast(`删除功能失败：${errorMessage(error)}`, 'error');
    } finally {
      setBusyId(null);
    }
  }

  function renderFields(values: FeatureDraft, onChange: (patch: Partial<FeatureDraft>) => void, prefix: string) {
    return (
      <div className="form-grid feature-form-grid">
        <label className="field field-span-2">
          <span className="field-label">功能标题</span>
          <input
            className="input"
            data-testid={`${prefix}-title-input`}
            value={values.title}
            placeholder="如：引用与逐条审阅闭环"
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
        <label className="field field-span-2">
          <span className="field-label">说明</span>
          <input
            className="input"
            data-testid={`${prefix}-description-input`}
            value={values.description}
            placeholder="一句话说明功能范围（可选）"
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">状态</span>
          <select
            className="select"
            data-testid={`${prefix}-status-select`}
            value={values.status}
            onChange={(event) => onChange({ status: event.target.value as FeatureStatus })}
          >
            {FEATURE_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {FEATURE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">优先级</span>
          <select
            className="select"
            data-testid={`${prefix}-priority-select`}
            value={values.priority}
            onChange={(event) => onChange({ priority: event.target.value as FeatureDraft['priority'] })}
          >
            {PRIORITY_OPTIONS.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-span-2">
          <span className="field-label">关联章节</span>
          <select
            className="select"
            data-testid={`${prefix}-chapter-input`}
            value={values.chapterRef}
            onChange={(event) => onChange({ chapterRef: event.target.value })}
          >
            <option value="">（不关联章节）</option>
            {chapters.map((chapter) => (
              <option key={chapter} value={chapter}>
                {chapter}
              </option>
            ))}
            {values.chapterRef && !chapters.includes(values.chapterRef) ? (
              <option value={values.chapterRef}>{values.chapterRef}</option>
            ) : null}
          </select>
        </label>
      </div>
    );
  }

  return (
    <section className="p2-panel feature-panel" data-testid="feature-panel">
      <header className="p2-panel-head">
        <div className="p2-panel-title">
          <FeatureListIcon size={16} />
          <h2>功能清单</h2>
          <span className="count-badge">{features.length}</span>
        </div>
        <div className="p2-panel-actions">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-testid="btn-refresh-features"
            onClick={() => void loadFeatures()}
            disabled={loading}
          >
            <RefreshIcon size={13} />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-primary btn-xs"
            data-testid="btn-add-feature"
            onClick={() => {
              setAddOpen((open) => !open);
              setFormError(null);
            }}
          >
            <PlusIcon size={13} />
            新增功能
          </button>
        </div>
      </header>

      {listError ? (
        <p className="inline-error p2-panel-error" data-testid="feature-list-error">
          功能清单接口不可用：{listError}
        </p>
      ) : null}

      {addOpen ? (
        <div className="feature-add-form" data-testid="feature-add-form">
          {renderFields(draft, patchDraft, 'feature-new')}
          {formError && !editingId ? <p className="inline-error">{formError}</p> : null}
          <div className="feature-add-actions">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              data-testid="btn-save-feature"
              disabled={busyId === '__add__'}
              onClick={() => void handleAdd()}
            >
              <CheckIcon size={13} />
              添加功能
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setAddOpen(false);
                setDraft(EMPTY_DRAFT);
                setFormError(null);
              }}
            >
              <CloseIcon size={13} />
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="feature-list" data-testid="feature-list">
        {loading && features.length === 0 ? (
          <div className="p2-empty">
            <span className="spinner" />
            正在加载功能清单…
          </div>
        ) : features.length === 0 ? (
          <div className="p2-empty">暂无功能条目。点击「新增功能」录入第一条。</div>
        ) : (
          features.map((feature) => (
            <article
              key={feature.id}
              className={`feature-item${editingId === feature.id ? ' is-editing' : ''}`}
              data-testid="feature-item"
              data-feature-id={feature.id}
              data-status={feature.status}
            >
              {editingId === feature.id ? (
                <div className="feature-edit">
                  {renderFields(editDraft, patchEditDraft, 'feature-edit')}
                  {formError ? <p className="inline-error">{formError}</p> : null}
                  <div className="feature-add-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      data-testid="btn-save-feature-edit"
                      disabled={busyId === feature.id}
                      onClick={() => void handleSaveEdit(feature)}
                    >
                      <CheckIcon size={13} />
                      保存修改
                    </button>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="feature-item-head">
                    <span className="feature-title">{feature.title}</span>
                    <span className={`pill priority-${feature.priority}`}>{feature.priority}</span>
                    <span className={`pill feature-status status-${feature.status}`}>
                      {FEATURE_STATUS_LABELS[feature.status]}
                    </span>
                  </div>
                  <p className="feature-desc">{feature.description || '（无说明）'}</p>
                  <div className="feature-meta">
                    <span data-testid="feature-chapter-ref">
                      {feature.chapterRef ? `关联章节：${feature.chapterRef}` : '未关联章节'}
                    </span>
                    <label className="feature-quick-status">
                      状态
                      <select
                        className="select select-xs"
                        data-testid="feature-status-quick"
                        value={feature.status}
                        disabled={busyId === feature.id}
                        onChange={(event) => void handleQuickStatus(feature, event.target.value as FeatureStatus)}
                      >
                        {FEATURE_STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {FEATURE_STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="feature-actions">
                    <button
                      type="button"
                      className="btn btn-tiny"
                      data-testid="btn-edit-feature"
                      onClick={() => startEdit(feature)}
                    >
                      <EditIcon size={11} />
                      编辑
                    </button>
                    {confirmDeleteId === feature.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-tiny btn-danger"
                          data-testid="btn-confirm-delete-feature"
                          disabled={busyId === feature.id}
                          onClick={() => void handleDelete(feature)}
                        >
                          确认删除
                        </button>
                        <button type="button" className="btn btn-tiny" onClick={() => setConfirmDeleteId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-tiny btn-danger-ghost"
                        data-testid="btn-delete-feature"
                        onClick={() => setConfirmDeleteId(feature.id)}
                      >
                        <TrashIcon size={11} />
                        删除
                      </button>
                    )}
                  </div>
                </>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
