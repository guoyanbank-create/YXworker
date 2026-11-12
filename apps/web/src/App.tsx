/**
 * YXworker P0 单页工作台（本机单用户、桌面布局）。
 *
 * 编排：项目/文档/引用/版本加载，TipTap 编辑（800ms 防抖 + revision 乐观锁），
 * 建议生成（202 Run 轮询）、逐条采纳/拒绝/继续讨论、冲突处理、版本回退与 Word 导出、
 * 执行器/模型状态与故障演练。所有错误都以可读状态呈现，不白屏。
 */
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import * as api from './api/client';
import {
  RUN_POLL_INTERVAL_MS,
  errorHint,
  errorMessage,
  isApiError,
  isRunActive,
  sleep,
} from './api/client';
import type {
  DataLevel,
  Document,
  ExecutionBackendId,
  FaultKind,
  Project,
  Proposal,
  Reference,
  Run,
  StatusResponse,
  Tier,
  Version,
} from './api/types';
import { DATA_LEVEL_LABELS, TIER_LABELS } from './api/types';
import { EditorPane } from './editor/EditorPane';
import { setLocateHighlight } from './editor/extensions';
import { ErrorState } from './components/ErrorState';
import { LeftPanel } from './components/LeftPanel';
import { ProposalPanel } from './components/ProposalPanel';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { VersionDialog } from './components/VersionDialog';
import type { ApiErrorInfo, FaultResult, RunKind, SaveState, ToastItem } from './ui/types';

const EXAMPLE_PROJECT_NAME = '智惠导服智能问答优化';
const EXAMPLE_PROMPT = '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议';
const FAULT_PROMPT = '故障演练：引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议';
const AUTOSAVE_DEBOUNCE_MS = 800;

interface FatalError {
  message: string;
  code: string | null;
}

function toApiErrorInfo(error: unknown): ApiErrorInfo {
  const code = isApiError(error) ? error.code : null;
  return {
    code: code ?? 'unknown_error',
    message: errorMessage(error),
    hint: errorHint(code),
    at: new Date().toISOString(),
  };
}

export default function App() {
  // --- 服务端数据 ---
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [references, setReferences] = useState<Reference[]>([]);
  const [referencesError, setReferencesError] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [activeKind, setActiveKind] = useState<RunKind | null>(null);
  const [runError, setRunError] = useState<ApiErrorInfo | null>(null);

  // --- 启动/致命错误 ---
  const [booting, setBooting] = useState(true);
  const [fatalError, setFatalError] = useState<FatalError | null>(null);

  // --- 编辑器内容与自动保存 ---
  const [contentJson, setContentJson] = useState<unknown>(null);
  const [contentToken, setContentToken] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const revisionRef = useRef(0);
  const lastSavedRef = useRef('');
  const appliedSaveStateRef = useRef<SaveState>('saved');
  const saveTimerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const documentRef = useRef<Document | null>(null);
  const projectRef = useRef<Project | null>(null);
  const watcherRef = useRef<{ cancelled: boolean } | null>(null);
  const locateHighlightTimerRef = useRef<number | null>(null);

  // --- 对话输入与执行器 ---
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<Tier>('review');
  const [executor, setExecutor] = useState<ExecutionBackendId>('dsh');
  const [generating, setGenerating] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);

  // --- 版本/导出/数据分级/故障演练 ---
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [versionDialogInitialId, setVersionDialogInitialId] = useState<string | null>(null);
  const [versionsBusy, setVersionsBusy] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dataLevelBusy, setDataLevelBusy] = useState(false);
  const [faultBusy, setFaultBusy] = useState<FaultKind | null>(null);
  const [faultResult, setFaultResult] = useState<FaultResult | null>(null);

  // --- Toast ---
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(1);

  function pushToast(message: string, kind: ToastItem['kind'] = 'info'): void {
    const id = toastSeqRef.current;
    toastSeqRef.current += 1;
    setToasts((prev) => [...prev.slice(-2), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 6000);
  }

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (saveState === 'dirty' || saveState === 'saving' || saveState === 'error') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (watcherRef.current) watcherRef.current.cancelled = true;
      if (locateHighlightTimerRef.current !== null) window.clearTimeout(locateHighlightTimerRef.current);
    };
  }, []);

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  async function fetchStatus(): Promise<void> {
    try {
      const value = await api.getStatus();
      setStatus(value);
      setStatusError(null);
      if (value.app.mockMode) setExecutor('mock');
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }

  async function loadProject(projectId: string): Promise<void> {
    setBooting(true);
    try {
      const { project: loadedProject } = await api.getProject(projectId);
      setProject(loadedProject);
      projectRef.current = loadedProject;
      setProjects((prev) => {
        const exists = prev.some((item) => item.id === loadedProject.id);
        return exists ? prev.map((item) => (item.id === loadedProject.id ? loadedProject : item)) : [...prev, loadedProject];
      });

      const documentId = loadedProject.documentId;
      const [docResult, proposalResult, versionResult, runResult, referenceResult] = await Promise.allSettled([
        api.getDocument(documentId),
        api.listProposals(documentId),
        api.listVersions(documentId),
        api.listProjectRuns(loadedProject.id),
        api.listReferences(loadedProject.id),
      ]);

      if (docResult.status === 'rejected') throw docResult.reason;
      const loadedDocument = docResult.value.document;
      documentRef.current = loadedDocument;
      revisionRef.current = loadedDocument.revision;
      appliedSaveStateRef.current = 'saved';
      lastSavedRef.current = '';
      setDocument(loadedDocument);
      setContentJson(loadedDocument.contentJson);
      setContentToken((token) => token + 1);

      if (proposalResult.status === 'fulfilled') {
        setProposals(proposalResult.value.proposals);
        setProposalsError(null);
      } else {
        setProposals([]);
        setProposalsError(errorMessage(proposalResult.reason));
      }

      setVersions(versionResult.status === 'fulfilled' ? versionResult.value.versions : []);

      if (runResult.status === 'fulfilled') {
        const runs = runResult.value.runs;
        setRecentRuns(runs);
        const running = runs.find((run) => isRunActive(run));
        if (running) {
          void watchRun(running, running.type === 'discussion' ? 'discuss' : 'generate', {});
        }
      } else {
        setRecentRuns([]);
      }

      if (referenceResult.status === 'fulfilled') {
        setReferences(referenceResult.value.references);
        setReferencesError(null);
      } else {
        setReferences([]);
        setReferencesError(errorMessage(referenceResult.reason));
      }
    } finally {
      setBooting(false);
    }
  }

  async function bootWorkspace(): Promise<void> {
    setBooting(true);
    setFatalError(null);
    void fetchStatus();
    try {
      const { projects: list } = await api.listProjects();
      setProjects(list);
      let target = list[0];
      if (!target) {
        const { project: created } = await api.createProject({
          name: EXAMPLE_PROJECT_NAME,
          description: '本机 P0 演示项目（4 章节方案）',
          dataLevel: 'internal',
        });
        target = created;
        setProjects([created]);
        pushToast('未发现项目，已自动创建本机演示项目。', 'info');
      }
      await loadProject(target.id);
    } catch (error) {
      setFatalError({
        message: errorMessage(error),
        code: isApiError(error) ? error.code : null,
      });
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    void bootWorkspace();
    // 仅在首次挂载时启动；后续刷新由显式操作触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSelectProject(projectId: string): Promise<void> {
    if (projectId === projectRef.current?.id) return;
    try {
      await flushSave();
      await loadProject(projectId);
      pushToast('已切换项目。', 'info');
    } catch (error) {
      pushToast(`切换项目失败：${errorMessage(error)}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // 编辑器与自动保存
  // -------------------------------------------------------------------------

  function handleEditorReady(editor: Editor): void {
    if (editor.isDestroyed) return;
    editorRef.current = editor;
    lastSavedRef.current = JSON.stringify(editor.getJSON());
    setSaveState(appliedSaveStateRef.current);
  }

  function handleContentApplied(): void {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    lastSavedRef.current = JSON.stringify(editor.getJSON());
    setSaveState(appliedSaveStateRef.current);
  }

  async function saveCurrentContent(): Promise<void> {
    const editor = editorRef.current;
    const currentDocument = documentRef.current;
    if (!editor || editor.isDestroyed || !currentDocument) return;
    const json = editor.getJSON();
    const serialized = JSON.stringify(json);
    if (serialized === lastSavedRef.current) {
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    setSaveError(null);
    try {
      const result = await api.saveDocumentContent(currentDocument.id, {
        contentJson: json,
        baseRevision: revisionRef.current,
      });
      revisionRef.current = result.document.revision;
      lastSavedRef.current = serialized;
      const nextDocument: Document = {
        ...currentDocument,
        revision: result.document.revision,
        paragraphs: result.document.paragraphs,
        updatedAt: result.document.updatedAt,
        title: result.document.title,
      };
      documentRef.current = nextDocument;
      setDocument((prev) => (prev && prev.id === nextDocument.id ? nextDocument : prev));
      setSaveState('saved');
      if (result.conflictedProposals.length > 0) {
        setProposals((prev) =>
          prev.map((proposal) => {
            const hit = result.conflictedProposals.find((item) => item.id === proposal.id);
            return hit ?? proposal;
          }),
        );
        pushToast(
          `保存成功，但 ${result.conflictedProposals.length} 条建议因目标段落被修改而转为「冲突」。`,
          'error',
        );
        void refreshProposals();
      }
    } catch (error) {
      if (isApiError(error) && error.code === 'revision_conflict') {
        setSaveState('conflict');
        setSaveError('检测到版本冲突：文档已在别处更新，已重新加载最新内容（未自动覆盖）。');
        pushToast('保存冲突：已重新加载最新文档，请确认后再继续编辑。', 'error');
        await reloadDocumentFromServer('conflict', '文档已在别处更新，已重新加载最新 revision（未自动覆盖本地修改）。');
      } else {
        setSaveState('error');
        setSaveError(errorMessage(error));
        pushToast(`自动保存失败：${errorMessage(error)}`, 'error');
      }
    }
  }

  function enqueueSave(): Promise<void> {
    saveChainRef.current = saveChainRef.current.then(
      () => saveCurrentContent(),
      () => saveCurrentContent(),
    );
    return saveChainRef.current;
  }

  function handleEditorUpdate(_editor: Editor): void {
    setSaveState((state) => (state === 'saving' ? state : 'dirty'));
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void enqueueSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function flushSave(): Promise<void> {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await enqueueSave();
  }

  async function reloadDocumentFromServer(stateAfter: SaveState, notice: string | null = null): Promise<void> {
    const currentDocument = documentRef.current;
    if (!currentDocument) return;
    try {
      const { document: fresh } = await api.getDocument(currentDocument.id);
      documentRef.current = fresh;
      revisionRef.current = fresh.revision;
      appliedSaveStateRef.current = stateAfter;
      setContentJson(fresh.contentJson);
      setContentToken((token) => token + 1);
      if (notice) setSaveError(notice);
    } catch (error) {
      pushToast(`重新加载文档失败：${errorMessage(error)}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // 数据刷新
  // -------------------------------------------------------------------------

  async function refreshProposals(): Promise<void> {
    const documentId = documentRef.current?.id;
    if (!documentId) return;
    setProposalsLoading(true);
    try {
      const { proposals: list } = await api.listProposals(documentId);
      setProposals(list);
      setProposalsError(null);
    } catch (error) {
      setProposalsError(errorMessage(error));
    } finally {
      setProposalsLoading(false);
    }
  }

  async function refreshProposal(proposalId: string): Promise<void> {
    try {
      const { proposal } = await api.getProposal(proposalId);
      setProposals((prev) => prev.map((item) => (item.id === proposal.id ? proposal : item)));
    } catch (error) {
      pushToast(`刷新建议失败：${errorMessage(error)}`, 'error');
    }
  }

  async function refreshRecentRuns(): Promise<void> {
    const projectId = projectRef.current?.id;
    if (!projectId) return;
    try {
      const { runs } = await api.listProjectRuns(projectId);
      setRecentRuns(runs);
    } catch {
      /* 运行记录刷新失败不影响主流程 */
    }
  }

  async function syncDocumentMeta(): Promise<void> {
    const currentDocument = documentRef.current;
    if (!currentDocument) return;
    try {
      const { document: fresh } = await api.getDocument(currentDocument.id);
      if (fresh.revision !== revisionRef.current) {
        documentRef.current = fresh;
        revisionRef.current = fresh.revision;
        appliedSaveStateRef.current = 'saved';
        setContentJson(fresh.contentJson);
        setContentToken((token) => token + 1);
      } else {
        documentRef.current = fresh;
        setDocument(fresh);
      }
    } catch {
      /* 非关键：文档元数据刷新失败不阻塞 */
    }
  }

  // -------------------------------------------------------------------------
  // 运行（生成/讨论）轮询
  // -------------------------------------------------------------------------

  async function watchRun(
    initialRun: Run,
    kind: RunKind,
    extras: { proposalId?: string; fault?: FaultKind },
  ): Promise<void> {
    if (watcherRef.current) watcherRef.current.cancelled = true;
    const token = { cancelled: false };
    watcherRef.current = token;
    let current = initialRun;
    setActiveRun(current);
    setActiveKind(kind);
    setRunBusy(true);
    setRunError(null);

    try {
      while (!token.cancelled && isRunActive(current)) {
        await sleep(RUN_POLL_INTERVAL_MS);
        if (token.cancelled) return;
        try {
          const { run } = await api.getRun(current.id);
          current = run;
          if (!token.cancelled) setActiveRun(run);
        } catch (error) {
          if (!token.cancelled) {
            setRunError(toApiErrorInfo(error));
            pushToast(`轮询运行状态失败：${errorMessage(error)}`, 'error');
          }
          return;
        }
      }
    } finally {
      if (!token.cancelled) setRunBusy(false);
    }
    if (token.cancelled) return;

    await refreshRecentRuns();

    if (current.status === 'succeeded') {
      await syncDocumentMeta();
      if (kind === 'discuss') {
        if (extras.proposalId) await refreshProposal(extras.proposalId);
        await refreshProposals();
        pushToast('继续讨论完成：仅该条建议已更新。', 'success');
      } else if (kind === 'fault') {
        await refreshProposals();
        setFaultResult({
          fault: extras.fault ?? 'rate_limit',
          code: 'succeeded',
          message: '运行成功，未得到预期错误（服务端可能未注入故障）。',
          blocked: false,
        });
      } else {
        await refreshProposals();
        pushToast('建议生成完成，已刷新建议列表。', 'success');
      }
    } else if (current.status === 'failed') {
      const failure: ApiErrorInfo = {
        code: current.error?.code ?? 'run_failed',
        message: current.error?.message ?? '运行失败',
        hint: errorHint(current.error?.code ?? null),
        at: current.updatedAt,
      };
      setRunError(failure);
      pushToast(`运行失败：${failure.code} — ${failure.message}`, 'error');
      if (kind === 'fault' && extras.fault) {
        setFaultResult({
          fault: extras.fault,
          code: failure.code,
          message: failure.message,
          blocked: true,
        });
      }
    } else if (current.status === 'cancelled') {
      pushToast('运行已取消，文档未受影响。', 'info');
    }
  }

  async function runGenerate(
    options: { promptOverride?: string; fault?: FaultKind; backendOverride?: ExecutionBackendId } = {},
  ): Promise<void> {
    const currentDocument = documentRef.current;
    if (!currentDocument) {
      pushToast('文档尚未加载完成，暂时无法生成建议。', 'error');
      return;
    }
    const text = (options.promptOverride ?? prompt).trim();
    if (!text) {
      pushToast('请先输入 AI 对话内容（可 @ 引用左侧资料）。', 'error');
      return;
    }
    const backend = options.backendOverride ?? executor;
    setGenerating(true);
    setRunError(null);
    try {
      await flushSave();
      const { run } = await api.generateProposals(currentDocument.id, {
        prompt: text,
        tier,
        backend,
        count: 5,
        fault: options.fault,
      });
      await watchRun(run, options.fault ? 'fault' : 'generate', { fault: options.fault });
    } catch (error) {
      const info = toApiErrorInfo(error);
      setRunError(info);
      setRunBusy(false);
      pushToast(`生成失败：${info.code} — ${info.message}`, 'error');
      if (options.fault) {
        setFaultResult({ fault: options.fault, code: info.code, message: info.message, blocked: true });
      }
    } finally {
      setGenerating(false);
    }
  }

  function handleGenerate(): void {
    void runGenerate();
  }

  async function handleCancelRun(): Promise<void> {
    const run = activeRun;
    if (!run) return;
    try {
      const { run: updated } = await api.cancelRun(run.id);
      setActiveRun(updated);
      pushToast('已请求取消运行。', 'info');
    } catch (error) {
      pushToast(`取消失败：${errorMessage(error)}`, 'error');
    }
  }

  function handleSelectRun(run: Run): void {
    setActiveRun(run);
    setActiveKind(run.type === 'discussion' ? 'discuss' : 'generate');
  }

  // -------------------------------------------------------------------------
  // 建议操作
  // -------------------------------------------------------------------------

  async function handleAccept(proposal: Proposal): Promise<void> {
    setBusyProposalId(proposal.id);
    try {
      await flushSave();
      const result = await api.acceptProposal(proposal.id, '本机审阅人');
      documentRef.current = result.document;
      revisionRef.current = result.document.revision;
      appliedSaveStateRef.current = 'saved';
      setDocument(result.document);
      setContentJson(result.document.contentJson);
      setContentToken((token) => token + 1);
      setProposals((prev) => prev.map((item) => (item.id === result.proposal.id ? result.proposal : item)));
      await refreshProposals();
      pushToast('已采纳建议并写入文档（仅该条）。', 'success');
    } catch (error) {
      const code = isApiError(error) ? error.code : null;
      pushToast(`采纳失败：${code ? `${code} — ` : ''}${errorMessage(error)}`, 'error');
      if (code === 'proposal_conflicted' || code === 'proposal_state_invalid' || code === 'apply_validation_failed') {
        await refreshProposals();
        if (code === 'proposal_conflicted') {
          await reloadDocumentFromServer(
            'saved',
            '目标段落已变化：该建议已标记为冲突，禁止覆盖；文档已刷新。',
          );
        }
      }
    } finally {
      setBusyProposalId(null);
    }
  }

  async function handleReject(proposal: Proposal): Promise<void> {
    setBusyProposalId(proposal.id);
    try {
      const { proposal: updated } = await api.rejectProposal(proposal.id, { reviewer: '本机审阅人' });
      setProposals((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      pushToast('已拒绝该建议，原文未修改。', 'success');
    } catch (error) {
      pushToast(`拒绝失败：${errorMessage(error)}`, 'error');
      if (isApiError(error) && error.code === 'proposal_state_invalid') await refreshProposals();
    } finally {
      setBusyProposalId(null);
    }
  }

  async function handleDiscuss(proposal: Proposal, message: string): Promise<void> {
    setBusyProposalId(proposal.id);
    setRunError(null);
    try {
      await flushSave();
      const { run } = await api.discussProposal(proposal.id, { message, tier });
      await watchRun(run, 'discuss', { proposalId: proposal.id });
    } catch (error) {
      const info = toApiErrorInfo(error);
      setRunError(info);
      pushToast(`继续讨论失败：${info.code} — ${info.message}`, 'error');
    } finally {
      setBusyProposalId(null);
    }
  }

  function handleLocate(proposal: Proposal): void {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !editor.view) {
      pushToast('编辑器尚未就绪。', 'error');
      return;
    }
    let foundPosition = -1;
    editor.state.doc.descendants((node, pos) => {
      if (foundPosition >= 0) return false;
      if (node.attrs.paragraphId === proposal.paragraphId) {
        foundPosition = pos;
        return false;
      }
      return true;
    });
    if (foundPosition < 0) {
      pushToast('未在正文中找到该段落（可能已被删除或整体重排）。', 'error');
      return;
    }
    editor.chain().focus().setTextSelection(foundPosition + 1).scrollIntoView().run();
    // 用 ProseMirror 装饰高亮目标段落（不修改正文、不触发保存）。
    setLocateHighlight(editor, proposal.paragraphId);
    if (locateHighlightTimerRef.current !== null) window.clearTimeout(locateHighlightTimerRef.current);
    locateHighlightTimerRef.current = window.setTimeout(() => {
      locateHighlightTimerRef.current = null;
      setLocateHighlight(editor, null);
    }, 2400);
  }

  // -------------------------------------------------------------------------
  // 版本 / 导出
  // -------------------------------------------------------------------------

  async function refreshVersions(): Promise<void> {
    const documentId = documentRef.current?.id;
    if (!documentId) return;
    const { versions: list } = await api.listVersions(documentId);
    setVersions(list);
  }

  async function openVersionDialog(initialId: string | null = null): Promise<void> {
    setVersionDialogOpen(true);
    setVersionDialogInitialId(initialId);
    setVersionsError(null);
    setVersionsBusy(true);
    try {
      await refreshVersions();
    } catch (error) {
      setVersionsError(`版本加载失败：${errorMessage(error)}`);
    } finally {
      setVersionsBusy(false);
    }
  }

  async function handleRefreshVersions(): Promise<void> {
    setVersionsBusy(true);
    setVersionsError(null);
    try {
      await refreshVersions();
    } catch (error) {
      setVersionsError(`版本加载失败：${errorMessage(error)}`);
    } finally {
      setVersionsBusy(false);
    }
  }

  async function handleCreateVersion(name: string): Promise<void> {
    const documentId = documentRef.current?.id;
    if (!documentId) return;
    setVersionsBusy(true);
    setVersionsError(null);
    try {
      await flushSave();
      const { version } = await api.createVersion(documentId, name);
      await refreshVersions();
      setVersionDialogInitialId(version.id);
      pushToast(`已创建命名版本 ${version.name}（revision ${version.revision}）。`, 'success');
    } catch (error) {
      setVersionsError(`创建版本失败：${errorMessage(error)}`);
    } finally {
      setVersionsBusy(false);
    }
  }

  async function handleRestoreVersion(versionId: string): Promise<void> {
    setVersionsBusy(true);
    setVersionsError(null);
    try {
      const { document: fresh } = await api.restoreVersion(versionId);
      documentRef.current = fresh;
      revisionRef.current = fresh.revision;
      appliedSaveStateRef.current = 'saved';
      setDocument(fresh);
      setContentJson(fresh.contentJson);
      setContentToken((token) => token + 1);
      await Promise.all([refreshVersions(), refreshProposals()]);
      pushToast('已回退到所选版本（生成新 revision，历史版本保留）。', 'success');
    } catch (error) {
      setVersionsError(`回退失败：${errorMessage(error)}`);
    } finally {
      setVersionsBusy(false);
    }
  }

  async function handleExport(versionId?: string): Promise<void> {
    const currentDocument = documentRef.current;
    if (!currentDocument) return;
    setExporting(true);
    try {
      if (!versionId) await flushSave();
      const filename = await api.downloadDocx(currentDocument.id, versionId);
      pushToast(`已导出 Word 文档：${filename}`, 'success');
    } catch (error) {
      pushToast(`导出失败：${errorMessage(error)}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  // -------------------------------------------------------------------------
  // 数据分级 / 引用 / 故障演练
  // -------------------------------------------------------------------------

  async function handleChangeDataLevel(level: DataLevel): Promise<void> {
    const currentProject = projectRef.current;
    if (!currentProject || level === currentProject.dataLevel) return;
    setDataLevelBusy(true);
    try {
      const { project: updated } = await api.patchProject(currentProject.id, { dataLevel: level });
      projectRef.current = updated;
      setProject(updated);
      pushToast(
        level === 'secret'
          ? '数据分级已改为「机密」：外部模型调用将被服务端阻断。'
          : `数据分级已改为「${DATA_LEVEL_LABELS[level]}」。`,
        'info',
      );
    } catch (error) {
      pushToast(`修改数据分级失败：${errorMessage(error)}`, 'error');
    } finally {
      setDataLevelBusy(false);
    }
  }

  async function handleUploadReference(file: File): Promise<void> {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    setUploadingReference(true);
    try {
      const { reference } = await api.uploadReference(currentProject.id, file);
      setReferences((prev) => [...prev, reference]);
      setReferencesError(null);
      pushToast(`已上传引用资料：${reference.title}`, 'success');
    } catch (error) {
      pushToast(`上传引用失败：${errorMessage(error)}`, 'error');
    } finally {
      setUploadingReference(false);
    }
  }

  function handleInsertReference(reference: Reference): void {
    setPrompt((prev) => `${prev}${prev.length > 0 && !prev.endsWith(' ') ? ' ' : ''}@${reference.title} `);
    pushToast(`已把「${reference.title}」插入对话。`, 'info');
  }

  async function handleFault(fault: FaultKind): Promise<void> {
    if (status !== null && !status.faultInjectionEnabled) {
      pushToast('服务端未开启故障注入（YXWORKER_FAULT_INJECTION=0）。', 'error');
      return;
    }
    setFaultBusy(fault);
    setFaultResult(null);
    const currentProject = projectRef.current;
    const previousLevel = currentProject?.dataLevel ?? 'internal';
    try {
      if (fault === 'data_policy' && currentProject) {
        setDataLevelBusy(true);
        const { project: mutated } = await api.patchProject(currentProject.id, { dataLevel: 'secret' });
        projectRef.current = mutated;
        setProject(mutated);
        pushToast('数据分级已临时置为「机密」，正在调用真实模型验证外发阻断…', 'info');
        try {
          await runGenerate({ promptOverride: FAULT_PROMPT, fault: 'data_policy', backendOverride: 'dsh' });
        } finally {
          try {
            const { project: restored } = await api.patchProject(currentProject.id, { dataLevel: previousLevel });
            projectRef.current = restored;
            setProject(restored);
          } catch (error) {
            pushToast(`恢复数据分级失败：${errorMessage(error)}`, 'error');
          }
          setDataLevelBusy(false);
        }
      } else {
        await runGenerate({ promptOverride: FAULT_PROMPT, fault, backendOverride: executor });
      }
    } catch (error) {
      const info = toApiErrorInfo(error);
      setRunError(info);
      setFaultResult({ fault, code: info.code, message: info.message, blocked: true });
      pushToast(`故障演练失败：${errorMessage(error)}`, 'error');
    } finally {
      setFaultBusy(null);
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const faultEnabled = status?.faultInjectionEnabled ?? true;

  return (
    <div className="app">
      <TopBar
        project={project}
        document={document}
        versions={versions}
        saveState={saveState}
        saveError={saveError}
        executor={executor}
        tierLabel={TIER_LABELS[tier]}
        status={status}
        exporting={exporting}
        dataLevelBusy={dataLevelBusy}
        onOpenVersions={() => void openVersionDialog(null)}
        onExport={() => void handleExport()}
        onPreviewVersion={(versionId) => void openVersionDialog(versionId)}
        onChangeDataLevel={(level) => void handleChangeDataLevel(level)}
      />

      <div className="workspace">
        <LeftPanel
          project={project}
          projects={projects}
          document={document}
          status={status}
          statusError={statusError}
          references={references}
          referencesError={referencesError}
          uploadingReference={uploadingReference}
          prompt={prompt}
          tier={tier}
          executor={executor}
          generating={generating}
          activeRun={activeRun}
          activeKind={activeKind}
          recentRuns={recentRuns}
          runError={runError}
          runBusy={runBusy}
          faultEnabled={faultEnabled}
          faultBusy={faultBusy}
          faultResult={faultResult}
          onPromptChange={setPrompt}
          onTierChange={setTier}
          onExecutorChange={setExecutor}
          onGenerate={handleGenerate}
          onFillExample={() => setPrompt(EXAMPLE_PROMPT)}
          onInsertReference={handleInsertReference}
          onUploadReference={(file) => void handleUploadReference(file)}
          onSelectProject={(projectId) => void handleSelectProject(projectId)}
          onRefreshStatus={() => void fetchStatus()}
          onCancelRun={() => void handleCancelRun()}
          onSelectRun={handleSelectRun}
          onRefreshRuns={() => void refreshRecentRuns()}
          onFault={(fault) => void handleFault(fault)}
        />

        <main className="center-panel" data-testid="center-panel">
          {fatalError ? (
            <ErrorState
              message={fatalError.message}
              code={fatalError.code}
              retrying={booting}
              onRetry={() => void bootWorkspace()}
            />
          ) : !document || contentJson === null ? (
            <div className="center-loading" data-testid="center-loading">
              <span className="spinner" />
              <p>{booting ? '正在加载工作台…' : '正在加载文档…'}</p>
            </div>
          ) : (
            <>
              {saveState === 'error' && saveError ? (
                <div className="status-banner is-error" data-testid="save-error-banner">
                  <span>保存失败：{saveError}</span>
                  <button type="button" className="btn btn-tiny" onClick={() => void enqueueSave()}>
                    重试保存
                  </button>
                </div>
              ) : null}
              {saveState === 'conflict' && saveError ? (
                <div className="status-banner is-warn" data-testid="save-conflict-banner">
                  <span>{saveError}</span>
                </div>
              ) : null}
              <EditorPane
                key={document.id}
                initialContent={contentJson}
                contentToken={contentToken}
                contentToApply={contentJson}
                onReady={handleEditorReady}
                onUpdate={handleEditorUpdate}
                onContentApplied={handleContentApplied}
              />
            </>
          )}
        </main>

        <ProposalPanel
          proposals={proposals}
          loading={proposalsLoading}
          error={proposalsError}
          busyProposalId={busyProposalId}
          onAccept={(proposal) => void handleAccept(proposal)}
          onReject={(proposal) => void handleReject(proposal)}
          onDiscuss={(proposal, message) => void handleDiscuss(proposal, message)}
          onLocate={handleLocate}
          onRefresh={() => void refreshProposals()}
        />
      </div>

      <VersionDialog
        open={versionDialogOpen}
        initialVersionId={versionDialogInitialId}
        versions={versions}
        loading={versionsBusy}
        busy={versionsBusy || exporting}
        error={versionsError}
        onClose={() => setVersionDialogOpen(false)}
        onRefresh={() => void handleRefreshVersions()}
        onCreate={(name) => void handleCreateVersion(name)}
        onRestore={(versionId) => void handleRestoreVersion(versionId)}
        onExportVersion={(versionId) => void handleExport(versionId)}
      />

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((toast) => toast.id !== id))} />
    </div>
  );
}
