/**
 * P2 图表面板：Mermaid 源码 CRUD + 浏览器内渲染预览（mermaid 包，securityLevel=strict）
 * + 绑定版本（当前 revision 或命名版本 V1.0/V1.1…）。
 *
 * 安全边界：服务端只保存源码；渲染全部发生在浏览器，且 strict 模式禁止脚本/HTML。
 * 渲染失败显示可读错误（不静默、不白屏）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import * as api from '../api/client';
import { errorMessage, isApiError } from '../api/client';
import type { Diagram, Version } from '../api/types';
import { DIAGRAM_KINDS, DIAGRAM_KIND_LABELS } from '../api/types';
import { formatDateTime, truncate } from '../utils/format';
import {
  CheckIcon,
  CloseIcon,
  DiagramIcon,
  EditIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from './Icons';

// 全局只初始化一次；strict 模式：不信任源码中的 HTML/脚本。
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
  flowchart: { htmlLabels: false, curve: 'basis' },
});

const DEFAULT_SOURCE = `flowchart TD
  A[用户提问] --> B{命中知识库?}
  B -- 是 --> C[三层检索 + 重排]
  B -- 否 --> D[转人工坐席]
  C --> E[大模型生成答案]
  E --> F[引用溯源与置信度]`;

export interface DiagramPanelProps {
  projectId: string | null;
  documentRevision: number | null;
  versions: Version[];
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

interface DiagramForm {
  id: string | null;
  title: string;
  kind: string;
  source: string;
  description: string;
  chapterRef: string;
  versionId: string;
}

type PreviewState =
  | { status: 'idle'; svg: string; error: null }
  | { status: 'rendering'; svg: string; error: null }
  | { status: 'ok'; svg: string; error: null }
  | { status: 'error'; svg: string; error: string };

function emptyForm(): DiagramForm {
  return {
    id: null,
    title: '',
    kind: 'flowchart',
    source: DEFAULT_SOURCE,
    description: '',
    chapterRef: '',
    versionId: '',
  };
}

function formFromDiagram(diagram: Diagram): DiagramForm {
  return {
    id: diagram.id,
    title: diagram.title,
    kind: diagram.kind,
    source: diagram.source,
    description: diagram.description,
    chapterRef: diagram.chapterRef ?? '',
    versionId: '',
  };
}

function codePrefix(error: unknown): string {
  return isApiError(error) ? `[${error.code}] ` : '';
}

function bindingLabel(diagram: Diagram): string {
  if (diagram.versionName) return `${diagram.versionName}（rev ${diagram.documentRevision ?? '—'}）`;
  if (diagram.documentRevision != null) return `当前工作版本 rev ${diagram.documentRevision}`;
  return '未绑定版本';
}

export function DiagramPanel({ projectId, documentRevision, versions, onToast }: DiagramPanelProps) {
  const [diagrams, setDiagrams] = useState<Diagram[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<DiagramForm | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle', svg: '', error: null });
  const previewSeqRef = useRef(0);

  const loadDiagrams = useCallback(async () => {
    if (!projectId) {
      setDiagrams([]);
      return;
    }
    setLoading(true);
    try {
      const { diagrams: list } = await api.listDiagrams(projectId);
      setDiagrams(list);
      setListError(null);
      setForm((current) => current ?? (list.length > 0 ? formFromDiagram(list[0]) : emptyForm()));
    } catch (error) {
      setDiagrams([]);
      setListError(`${codePrefix(error)}${errorMessage(error)}`);
      // 接口未就绪时仍保留本地草稿编辑与 Mermaid 预览能力（不白屏/不空面板）。
      setForm((current) => current ?? emptyForm());
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setForm(null);
    setFormError(null);
    setConfirmDeleteId(null);
    void loadDiagrams();
  }, [loadDiagrams]);

  // 源码变化后自动渲染预览（防抖），失败时保留错误而不是清空。
  const source = form?.source ?? '';
  useEffect(() => {
    const trimmed = source.trim();
    if (trimmed.length === 0) {
      setPreview({ status: 'idle', svg: '', error: null });
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreview((prev) => ({ status: 'rendering', svg: prev.svg, error: null }));
    const timer = window.setTimeout(() => {
      void (async () => {
        const renderId = `yx-mermaid-${Date.now()}-${seq}`;
        try {
          const { svg } = await mermaid.render(renderId, trimmed);
          if (seq !== previewSeqRef.current) return;
          setPreview({ status: 'ok', svg, error: null });
        } catch (error) {
          if (seq !== previewSeqRef.current) return;
          // mermaid 渲染失败时会遗留临时节点，主动清理。
          document.getElementById(renderId)?.remove();
          document.getElementById(`d${renderId}`)?.remove();
          setPreview({ status: 'error', svg: '', error: errorMessage(error) });
        }
      })();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [source]);

  const versionOptions = useMemo(
    () => versions.map((version) => ({ id: version.id, label: `${version.name}（rev ${version.revision}）` })),
    [versions],
  );

  function patchForm(patch: Partial<DiagramForm>): void {
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  function startNew(): void {
    setForm(emptyForm());
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function startEdit(diagram: Diagram): void {
    setForm(formFromDiagram(diagram));
    setFormError(null);
    setConfirmDeleteId(null);
  }

  async function handleSave(): Promise<void> {
    if (!projectId || !form) return;
    const title = form.title.trim();
    if (!title) {
      setFormError('请填写图表标题。');
      return;
    }
    if (form.source.trim().length === 0) {
      setFormError('Mermaid 源码不能为空。');
      return;
    }
    if (preview.status === 'error') {
      setFormError(`Mermaid 源码渲染失败，请先修正后再保存：${preview.error}`);
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      const payload: api.DiagramInput = {
        title,
        kind: form.kind,
        source: form.source,
        description: form.description,
        chapterRef: form.chapterRef.trim() || null,
        ...(form.versionId ? { versionId: form.versionId } : {}),
      };
      const result = form.id
        ? await api.updateDiagram(form.id, payload)
        : await api.createDiagram(projectId, payload);
      setForm(formFromDiagram(result.diagram));
      await loadDiagrams();
      onToast(form.id ? `图表「${title}」已保存。` : `图表「${title}」已创建。`, 'success');
    } catch (error) {
      setFormError(`${codePrefix(error)}${errorMessage(error)}`);
      onToast(`保存图表失败：${errorMessage(error)}`, 'error');
    } finally {
      setFormBusy(false);
    }
  }

  async function handleBind(): Promise<void> {
    if (!form?.id || !form.versionId) return;
    setFormBusy(true);
    setFormError(null);
    try {
      const { diagram } = await api.bindDiagram(form.id, form.versionId);
      setForm(formFromDiagram(diagram));
      await loadDiagrams();
      onToast(`图表已绑定版本 ${diagram.versionName ?? ''}（rev ${diagram.documentRevision}）。`, 'success');
    } catch (error) {
      setFormError(`${codePrefix(error)}${errorMessage(error)}`);
      onToast(`绑定版本失败：${errorMessage(error)}`, 'error');
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(diagram: Diagram): Promise<void> {
    setFormBusy(true);
    setFormError(null);
    try {
      await api.deleteDiagram(diagram.id);
      setConfirmDeleteId(null);
      if (form?.id === diagram.id) setForm(emptyForm());
      await loadDiagrams();
      onToast(`图表「${diagram.title}」已删除。`, 'success');
    } catch (error) {
      setFormError(`${codePrefix(error)}${errorMessage(error)}`);
      onToast(`删除图表失败：${errorMessage(error)}`, 'error');
    } finally {
      setFormBusy(false);
    }
  }

  return (
    <section className="p2-panel diagram-panel" data-testid="diagram-panel">
      <header className="p2-panel-head">
        <div className="p2-panel-title">
          <DiagramIcon size={16} />
          <h2>图表（Mermaid）</h2>
          <span className="count-badge">{diagrams.length}</span>
        </div>
        <div className="p2-panel-actions">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-testid="btn-refresh-diagrams"
            onClick={() => void loadDiagrams()}
            disabled={loading}
          >
            <RefreshIcon size={13} />
            刷新
          </button>
          <button type="button" className="btn btn-primary btn-xs" data-testid="btn-new-diagram" onClick={startNew}>
            <PlusIcon size={13} />
            新建图表
          </button>
        </div>
      </header>

      <p className="p2-panel-hint">
        服务端只保存 Mermaid 源码；预览在本机浏览器渲染（securityLevel=strict，不执行源码脚本）。默认绑定当前文档 revision，也可绑定命名版本。
      </p>

      {listError ? (
        <p className="inline-error p2-panel-error" data-testid="diagram-list-error">
          图表接口不可用：{listError}（可继续在右侧编辑源码预览，后端就绪后自动可用）
        </p>
      ) : null}

      <div className="diagram-layout">
        <div className="diagram-list" data-testid="diagram-list">
          {loading && diagrams.length === 0 ? (
            <div className="p2-empty">
              <span className="spinner" />
              正在加载图表…
            </div>
          ) : diagrams.length === 0 ? (
            <div className="p2-empty">暂无图表。点击「新建图表」创建第一张 Mermaid 图表。</div>
          ) : (
            diagrams.map((diagram) => (
              <article
                key={diagram.id}
                className={`diagram-item${form?.id === diagram.id ? ' is-active' : ''}`}
                data-testid="diagram-item"
                data-diagram-id={diagram.id}
              >
                <div className="diagram-item-head">
                  <span className="diagram-item-title" title={diagram.title}>
                    {diagram.title}
                  </span>
                  <span className="pill pill-kind">{DIAGRAM_KIND_LABELS[diagram.kind] ?? diagram.kind}</span>
                </div>
                <p className="diagram-item-desc">{truncate(diagram.description || '（无说明）', 72)}</p>
                <div className="diagram-item-meta">
                  <span className="diagram-binding" data-testid="diagram-binding">
                    绑定：{bindingLabel(diagram)}
                  </span>
                  {diagram.chapterRef ? <span>章节：{diagram.chapterRef}</span> : null}
                  <span className="diagram-time">{formatDateTime(diagram.updatedAt)}</span>
                </div>
                <div className="diagram-item-actions">
                  <button
                    type="button"
                    className="btn btn-tiny"
                    data-testid="btn-edit-diagram"
                    onClick={() => startEdit(diagram)}
                  >
                    <EditIcon size={11} />
                    编辑
                  </button>
                  {confirmDeleteId === diagram.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-tiny btn-danger"
                        data-testid="btn-confirm-delete-diagram"
                        disabled={formBusy}
                        onClick={() => void handleDelete(diagram)}
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        className="btn btn-tiny"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-tiny btn-danger-ghost"
                      data-testid="btn-delete-diagram"
                      onClick={() => setConfirmDeleteId(diagram.id)}
                    >
                      <TrashIcon size={11} />
                      删除
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </div>

        <div className="diagram-editor" data-testid="diagram-editor">
          {form ? (
            <>
              <div className="diagram-editor-head">
                <h3>{form.id ? '编辑图表' : '新建图表'}</h3>
                <span className="diagram-editor-state">
                  {form.id ? '已有图表' : '未保存草稿'}
                </span>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">标题</span>
                  <input
                    className="input"
                    data-testid="diagram-title"
                    value={form.title}
                    placeholder="如：智能问答总体链路"
                    onChange={(event) => patchForm({ title: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">类型</span>
                  <select
                    className="select"
                    data-testid="diagram-kind"
                    value={form.kind}
                    onChange={(event) => patchForm({ kind: event.target.value })}
                  >
                    {DIAGRAM_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {DIAGRAM_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field field-span-2">
                  <span className="field-label">说明</span>
                  <input
                    className="input"
                    data-testid="diagram-description"
                    value={form.description}
                    placeholder="一句话说明图表用途（可选）"
                    onChange={(event) => patchForm({ description: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">关联章节</span>
                  <input
                    className="input"
                    data-testid="diagram-chapter-ref"
                    value={form.chapterRef}
                    placeholder="如：第三章 功能拆解与实施路径"
                    onChange={(event) => patchForm({ chapterRef: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">绑定版本</span>
                  <select
                    className="select"
                    data-testid="diagram-version-select"
                    value={form.versionId}
                    onChange={(event) => patchForm({ versionId: event.target.value })}
                  >
                    <option value="">当前工作版本（rev {documentRevision ?? '—'}）</option>
                    {versionOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field diagram-source-field">
                <span className="field-label">Mermaid 源码</span>
                <textarea
                  className="input diagram-source"
                  data-testid="diagram-source"
                  rows={9}
                  spellCheck={false}
                  value={form.source}
                  onChange={(event) => patchForm({ source: event.target.value })}
                />
              </label>

              {formError ? (
                <p className="inline-error" data-testid="diagram-form-error">
                  {formError}
                </p>
              ) : null}

              <div className="diagram-editor-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  data-testid="btn-save-diagram"
                  disabled={formBusy}
                  onClick={() => void handleSave()}
                >
                  <CheckIcon size={13} />
                  {formBusy ? '保存中…' : '保存图表'}
                </button>
                {form.id ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    data-testid="btn-bind-diagram"
                    disabled={formBusy || !form.versionId}
                    title="把该图表绑定到所选命名版本"
                    onClick={() => void handleBind()}
                  >
                    绑定所选版本
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  data-testid="btn-clear-diagram-form"
                  onClick={startNew}
                >
                  <CloseIcon size={13} />
                  清空表单
                </button>
              </div>

              <div className="mermaid-preview-wrap">
                <div className="mermaid-preview-head">
                  <span className="field-label">渲染预览</span>
                  {preview.status === 'rendering' ? <span className="spinner spinner-sm" /> : null}
                  <span className={`preview-state preview-${preview.status}`}>
                    {preview.status === 'ok'
                      ? '渲染成功'
                      : preview.status === 'rendering'
                        ? '渲染中…'
                        : preview.status === 'error'
                          ? '渲染失败'
                          : '等待源码'}
                  </span>
                </div>
                {preview.status === 'error' ? (
                  <pre className="mermaid-error" data-testid="mermaid-error">
                    {preview.error}
                  </pre>
                ) : null}
                <div
                  className="mermaid-preview"
                  data-testid="mermaid-preview"
                  data-state={preview.status}
                  // mermaid strict 模式输出的 SVG 已做安全过滤；服务端从不执行渲染结果。
                  dangerouslySetInnerHTML={{ __html: preview.svg }}
                />
              </div>
            </>
          ) : (
            <div className="p2-empty">选择左侧图表进行编辑，或新建图表。</div>
          )}
        </div>
      </div>
    </section>
  );
}
