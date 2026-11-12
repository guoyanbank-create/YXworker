/**
 * P1 引用资料 @ 定位浏览器：
 * - 引用项可展开小节/段落（GET /projects/:id/references/:refId/sections）；
 * - 顶部搜索框跨引用检索 locator + excerpt（GET /projects/:id/references/locators?q=）；
 * - 选择整份引用或具体小节后插入 @ 提及（上层把 referenceIds/referenceSectionIds 随 generate 发送）。
 * 接口未就绪/失败时展示可读错误，不影响其余工作台功能。
 */
import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { errorMessage, isApiError } from '../api/client';
import type { Reference, ReferenceLocatorResult, ReferenceSection } from '../api/types';
import type { MentionSelection } from '../ui/types';
import { formatCount, truncate } from '../utils/format';
import {
  AtIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  SearchIcon,
} from './Icons';

const SEARCH_DEBOUNCE_MS = 350;

interface SectionState {
  loading: boolean;
  sections: ReferenceSection[];
  error: string | null;
}

export interface ReferenceExplorerProps {
  projectId: string | null;
  references: Reference[];
  referencesError: string | null;
  selectedSectionIds: string[];
  selectedReferenceIds: string[];
  onInsertMention: (mention: MentionSelection) => void;
}

function codePrefix(error: unknown): string {
  return isApiError(error) ? `[${error.code}] ` : '';
}

export function ReferenceExplorer({
  projectId,
  references,
  referencesError,
  selectedSectionIds,
  selectedReferenceIds,
  onInsertMention,
}: ReferenceExplorerProps) {
  const [expandedRefId, setExpandedRefId] = useState<string | null>(null);
  const [sectionState, setSectionState] = useState<Record<string, SectionState>>({});
  const [query, setQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<ReferenceLocatorResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeqRef = useRef(0);

  // @ 检索：防抖，避免每次按键都打服务端；晚到的旧结果丢弃。
  useEffect(() => {
    const trimmed = query.trim();
    if (!projectId || trimmed.length === 0) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { results } = await api.searchReferenceLocators(projectId, trimmed, 20);
          if (seq !== searchSeqRef.current) return;
          setSearchResults(results);
          setSearchError(null);
        } catch (error) {
          if (seq !== searchSeqRef.current) return;
          setSearchResults([]);
          setSearchError(`${codePrefix(error)}${errorMessage(error)}`);
        } finally {
          if (seq === searchSeqRef.current) setSearchLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [projectId, query]);

  async function toggleSections(reference: Reference): Promise<void> {
    if (expandedRefId === reference.id) {
      setExpandedRefId(null);
      return;
    }
    setExpandedRefId(reference.id);
    if (sectionState[reference.id] && !sectionState[reference.id].error) return;
    if (!projectId) return;
    setSectionState((prev) => ({
      ...prev,
      [reference.id]: { loading: true, sections: prev[reference.id]?.sections ?? [], error: null },
    }));
    try {
      const { sections } = await api.listReferenceSections(projectId, reference.id);
      setSectionState((prev) => ({
        ...prev,
        [reference.id]: { loading: false, sections, error: null },
      }));
    } catch (error) {
      setSectionState((prev) => ({
        ...prev,
        [reference.id]: {
          loading: false,
          sections: prev[reference.id]?.sections ?? [],
          error: `${codePrefix(error)}${errorMessage(error)}`,
        },
      }));
    }
  }

  function insertReference(reference: Reference): void {
    onInsertMention({
      referenceId: reference.id,
      referenceTitle: reference.title,
      sectionId: null,
      locator: null,
    });
  }

  function insertSection(reference: Reference, section: ReferenceSection): void {
    onInsertMention({
      referenceId: reference.id,
      referenceTitle: reference.title,
      sectionId: section.id,
      locator: section.locator,
    });
  }

  function insertSearchResult(result: ReferenceLocatorResult): void {
    onInsertMention({
      referenceId: result.referenceId,
      referenceTitle: result.referenceTitle,
      sectionId: result.sectionId,
      locator: result.locator,
    });
  }

  const currentSectionState = expandedRefId ? sectionState[expandedRefId] : undefined;

  return (
    <div className="reference-explorer" data-testid="reference-explorer">
      <label className="ref-search">
        <SearchIcon size={13} />
        <input
          className="input ref-search-input"
          data-testid="ref-locator-search"
          value={query}
          placeholder="搜索引用定位（小节 / locator / 正文片段）"
          onChange={(event) => setQuery(event.target.value)}
          disabled={!projectId || references.length === 0}
        />
        {searchLoading ? <span className="spinner spinner-sm" /> : null}
      </label>

      {query.trim().length > 0 ? (
        <div className="ref-search-panel" data-testid="ref-search-results">
          {searchError ? (
            <p className="inline-error" data-testid="ref-search-error">
              引用定位搜索失败：{searchError}
            </p>
          ) : searchResults === null ? (
            <p className="section-empty">检索中…</p>
          ) : searchResults.length === 0 ? (
            <p className="section-empty">未找到匹配「{query.trim()}」的引用定位。</p>
          ) : (
            <ul className="ref-search-list">
              {searchResults.map((result) => (
                <li key={`${result.referenceId}-${result.sectionId}`}>
                  <button
                    type="button"
                    className="ref-search-result"
                    data-testid="ref-search-result"
                    data-reference-id={result.referenceId}
                    data-section-id={result.sectionId}
                    title={`插入 @${result.referenceTitle} · ${result.locator}`}
                    onClick={() => insertSearchResult(result)}
                  >
                    <span className="ref-search-result-head">
                      <span className="ref-search-result-ref">{result.referenceTitle}</span>
                      <span className="ref-search-result-locator">{result.locator}</span>
                    </span>
                    <span className="ref-search-result-excerpt">{truncate(result.excerpt, 90)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {references.length === 0 ? (
        <p className="section-empty">暂无引用资料。上传历史方案或技术说明后，可在对话中用 @ 引用具体小节。</p>
      ) : (
        <ul className="reference-list" data-testid="reference-list">
          {references.map((reference) => {
            const expanded = expandedRefId === reference.id;
            const refSelected = selectedReferenceIds.includes(reference.id);
            const state = expanded ? currentSectionState : sectionState[reference.id];
            return (
              <li key={reference.id} className={`reference-item${expanded ? ' is-expanded' : ''}`} data-testid="reference-item">
                <div className="reference-main">
                  <div className="reference-title">
                    <FileIcon size={13} />
                    <span title={reference.title}>{reference.title}</span>
                  </div>
                  <div className="reference-meta">
                    <span className="reference-kind">{reference.kind.toUpperCase()}</span>
                    <span>{formatCount(reference.charCount)} 字</span>
                    {typeof reference.sectionCount === 'number' ? (
                      <span data-testid="reference-section-count">{reference.sectionCount} 小节</span>
                    ) : null}
                    {refSelected ? <span className="pill pill-current">已引用</span> : null}
                  </div>
                  <p className="reference-excerpt" title={reference.excerpt}>
                    {truncate(reference.excerpt, 64)}
                  </p>
                  <div className="reference-actions">
                    <button
                      type="button"
                      className="btn btn-tiny btn-section-toggle"
                      data-testid="btn-expand-sections"
                      aria-expanded={expanded}
                      onClick={() => void toggleSections(reference)}
                    >
                      {expanded ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
                      {expanded ? '收起小节' : '展开小节'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-tiny"
                      data-testid="btn-insert-ref"
                      title={`在对话中 @ 引用「${reference.title}」`}
                      onClick={() => insertReference(reference)}
                    >
                      <AtIcon size={12} />
                      插入引用
                    </button>
                  </div>
                </div>

                {expanded ? (
                  <div className="reference-sections" data-testid="ref-section-list">
                    {state?.loading ? (
                      <p className="section-empty">
                        <span className="spinner spinner-sm" /> 正在读取小节…
                      </p>
                    ) : null}
                    {state?.error ? (
                      <p className="inline-error" data-testid="ref-sections-error">
                        小节接口不可用：{state.error}
                      </p>
                    ) : null}
                    {!state?.loading && !state?.error && state?.sections.length === 0 ? (
                      <p className="section-empty">该引用尚无已切分小节（服务端未切分或旧数据）。</p>
                    ) : null}
                    {state && state.sections.length > 0 ? (
                      <ul className="ref-section-items">
                        {state.sections.map((section) => {
                          const active = selectedSectionIds.includes(section.id);
                          return (
                            <li key={section.id}>
                              <button
                                type="button"
                                className={`ref-section-item${active ? ' is-selected' : ''}`}
                                data-testid="ref-section-item"
                                data-section-id={section.id}
                                data-reference-id={reference.id}
                                title={`插入 @${reference.title} · ${section.locator}`}
                                onClick={() => insertSection(reference, section)}
                              >
                                <span className="ref-section-locator">{section.locator}</span>
                                <span className="ref-section-excerpt">{truncate(section.excerpt, 96)}</span>
                                <span className="ref-section-insert">
                                  <AtIcon size={11} />
                                  插入
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {referencesError ? <p className="inline-error">引用加载失败：{referencesError}</p> : null}
    </div>
  );
}
