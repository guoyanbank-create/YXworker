/**
 * P1 引用来源弹窗：建议卡片里的引用条目可点开，展示 locator 与原文正文，并高亮摘录。
 *
 * 契约里 citation 只有 referenceId/locator/excerpt（无 sectionId），因此先取该引用的
 * 小节列表（GET .../references/:refId/sections）按 locator/excerpt 匹配到 sectionId，
 * 再调 GET .../sections/:sectionId 打开完整正文；接口未就绪时降级展示卡片内摘录。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api/client';
import { errorMessage, isApiError } from '../api/client';
import type { Citation, ReferenceSection } from '../api/types';
import { CloseIcon, CopyIcon, LinkIcon, QuoteIcon, SearchIcon } from './Icons';

export interface SourceDialogProps {
  open: boolean;
  projectId: string | null;
  citation: Citation | null;
  onClose: () => void;
}

interface LoadedSource {
  title: string;
  section: ReferenceSection | null;
  /** 降级：接口未就绪时仍展示 citation 里的 locator/excerpt。 */
  fallback: boolean;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface ContentSegment {
  text: string;
  highlighted: boolean;
}

/** 在正文里定位 excerpt 并返回高亮分段；找不到时 matched=false 且仅一段原文。 */
function highlightContent(
  content: string,
  excerpt: string,
): { segments: ContentSegment[]; matched: boolean } {
  const candidates = [excerpt, excerpt.slice(0, 48), excerpt.slice(0, 24)]
    .map((item) => normalize(item))
    .filter((item) => item.length >= 8);
  const haystack = normalize(content);
  for (const candidate of candidates) {
    const index = haystack.indexOf(candidate);
    if (index >= 0) {
      const segments: ContentSegment[] = [];
      if (index > 0) segments.push({ text: haystack.slice(0, index), highlighted: false });
      segments.push({ text: haystack.slice(index, index + candidate.length), highlighted: true });
      if (index + candidate.length < haystack.length) {
        segments.push({ text: haystack.slice(index + candidate.length), highlighted: false });
      }
      return { segments, matched: true };
    }
  }
  return { segments: [{ text: haystack, highlighted: false }], matched: false };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function SourceDialog({ open, projectId, citation, onClose }: SourceDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const highlightRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !citation) {
      setLoaded(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(null);
    void (async () => {
      try {
        if (!projectId) throw new Error('项目尚未加载完成');
        const { sections } = await api.listReferenceSections(projectId, citation.referenceId);
        const excerpt = normalize(citation.excerpt);
        const found =
          sections.find((section) => section.locator === citation.locator) ??
          sections.find(
            (section) =>
              (excerpt.length > 0 &&
                (normalize(section.excerpt).includes(excerpt.slice(0, 24)) ||
                  normalize(section.content).includes(excerpt.slice(0, 24)))) ||
              false,
          ) ??
          null;
        if (!found) throw new Error('未找到对应小节（引用可能已更新）');
        const { section } = await api.getReferenceSection(projectId, citation.referenceId, found.id);
        if (!cancelled) {
          setLoaded({ title: citation.title, section, fallback: false });
        }
      } catch (loadError) {
        if (cancelled) return;
        const code = isApiError(loadError) ? `[${loadError.code}] ` : '';
        setError(`${code}${errorMessage(loadError)}`);
        setLoaded({ title: citation.title, section: null, fallback: true });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, citation, projectId]);

  const highlighted = useMemo(() => {
    if (!loaded?.section) return null;
    return highlightContent(loaded.section.content, citation?.excerpt ?? '');
  }, [loaded, citation]);

  // 弹窗打开后滚动到高亮摘录
  useEffect(() => {
    if (!open || loading) return;
    const timer = window.setTimeout(() => {
      highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [open, loading, loaded]);

  if (!open || !citation) return null;

  const section = loaded?.section ?? null;
  const locator = section?.locator ?? citation.locator;
  const excerpt = section?.excerpt || citation.excerpt;

  async function handleCopy(label: string, text: string): Promise<void> {
    const ok = await copyText(text);
    setCopied(ok ? `${label}已复制` : '复制失败（浏览器拒绝访问剪贴板）');
    window.setTimeout(() => setCopied(null), 2400);
  }

  function handleRelocate(): void {
    highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    contentRef.current?.classList.remove('is-flash');
    if (contentRef.current) {
      // 触发一次闪烁动画
      void contentRef.current.offsetWidth;
      contentRef.current.classList.add('is-flash');
    }
  }

  return (
    <div
      className="modal-overlay"
      data-testid="source-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="引用来源"
        data-testid="source-dialog"
      >
        <header className="modal-head">
          <div className="modal-title">
            <QuoteIcon size={16} />
            <h2>引用来源</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="关闭"
            aria-label="关闭引用来源"
            data-testid="btn-source-close"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="source-meta" data-testid="source-meta">
          <div className="source-ref-line">
            <LinkIcon size={13} />
            <span className="source-ref-title">{loaded?.title ?? citation.title}</span>
          </div>
          <div className="source-locator" data-testid="source-locator">
            {locator}
          </div>
        </div>

        {loading ? (
          <div className="source-loading">
            <span className="spinner" />
            正在打开来源小节…
          </div>
        ) : null}

        {error ? (
          <p className="inline-error modal-error" data-testid="source-error">
            {error}
            <span className="source-error-hint">（已降级展示建议卡片内的引用摘录）</span>
          </p>
        ) : null}

        <div className="source-body" data-testid="source-content" ref={contentRef}>
          {section && highlighted ? (
            <>
              <div className="source-section-title">{section.sectionTitle}</div>
              <p className="source-text">
                {highlighted.segments.map((segment, index) =>
                  segment.highlighted ? (
                    <mark
                      key={`m-${index}`}
                      ref={(element) => {
                        highlightRef.current = element;
                      }}
                      className="source-highlight"
                      data-testid="source-highlight"
                    >
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={`t-${index}`}>{segment.text}</span>
                  ),
                )}
              </p>
              {!highlighted.matched ? (
                <p className="source-hint">摘录未能在正文中精确匹配，已展示该小节完整正文。</p>
              ) : null}
            </>
          ) : !loading ? (
            <div className="source-fallback">
              <div className="source-section-title">引用摘录（降级视图）</div>
              <p className="source-text">
                <mark className="source-highlight" data-testid="source-highlight">
                  {excerpt}
                </mark>
              </p>
              <p className="source-hint">
                原文小节需后端 P1 接口（references/:refId/sections）就绪后展示。
              </p>
            </div>
          ) : null}
        </div>

        <footer className="source-actions">
          <span className="source-copied" data-testid="source-copied">
            {copied ?? ''}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-testid="btn-source-relocate"
            onClick={handleRelocate}
          >
            <SearchIcon size={13} />
            再次定位摘录
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-testid="btn-source-copy"
            onClick={() =>
              void handleCopy(
                '引用信息',
                `${citation.title}\n定位：${locator}\n摘录：${excerpt}`,
              )
            }
          >
            <CopyIcon size={13} />
            复制引用
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-testid="btn-source-copy-content"
            disabled={!section}
            onClick={() => void handleCopy('正文', section?.content ?? '')}
          >
            <CopyIcon size={13} />
            复制正文
          </button>
        </footer>
      </div>
    </div>
  );
}
