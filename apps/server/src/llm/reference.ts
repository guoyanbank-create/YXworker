/**
 * 引用材料处理：从服务端持有的引用正文中推导可见小节定位符与摘录片段。
 * 用于 (a) 给模型提供 locator 候选；(b) 校验/修正模型给出的 citations。
 */
import type { ReferenceMaterial } from './types.js';

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 从 Markdown 正文中提取 `##`/`###` 小节标题作为 locator 候选（不把文档标题当 locator）。 */
export function parseLocators(content: string): string[] {
  const locators: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\s{0,3}(#{2,6})\s+(.+?)\s*$/);
    if (match) {
      const locator = match[2].trim();
      if (locator.length > 0 && !locators.includes(locator)) locators.push(locator);
    }
  }
  return locators;
}

/** 取某个 locator 小节下的正文（归一化空白）；找不到时返回空串。 */
export function sectionText(content: string, locator: string): string {
  const lines = content.split('\n');
  const wanted = locator.trim();
  const start = lines.findIndex((line) => {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    return Boolean(heading && heading[1].trim() === wanted);
  });
  if (start < 0) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,3}#{1,6}\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return normalizeWhitespace(body.join(' '));
}

export interface ReferenceExcerpt {
  locator: string;
  excerpt: string;
}

/** 取引用在指定 locator 处的可见片段；locator 不存在时回退到全文开头。 */
export function excerptAt(
  reference: Pick<ReferenceMaterial, 'content' | 'locators'>,
  locator?: string,
  maxLen = 120,
): ReferenceExcerpt {
  const candidates = locator ? [locator, ...reference.locators] : reference.locators;
  for (const candidate of candidates) {
    const text = sectionText(reference.content, candidate);
    if (text.length > 0) {
      return { locator: candidate, excerpt: text.slice(0, maxLen) };
    }
  }
  const fallbackLocator = reference.locators[0] ?? '全文';
  return {
    locator: fallbackLocator,
    excerpt: normalizeWhitespace(reference.content).slice(0, maxLen),
  };
}

/** 判断摘录是否来自引用正文（空白归一化后做子串包含）。 */
export function excerptVisibleIn(content: string, excerpt: string): boolean {
  const needle = normalizeWhitespace(excerpt);
  if (needle.length === 0) return false;
  return normalizeWhitespace(content).includes(needle);
}
