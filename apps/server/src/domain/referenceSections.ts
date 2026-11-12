/**
 * 引用资料的小节/段落切分（P1：@ 定位到章节/段落、返回 locator + excerpt、来源打开）。
 *
 * 纯函数：上传/种子时切分并落库 reference_sections；检索与来源打开复用同一份数据。
 * 支持 Markdown 标题分节；无标题文本按段落归入「全文」。
 */
export interface ParsedReferenceSection {
  locator: string;
  sectionTitle: string;
  paragraphIndex: number;
  excerpt: string;
  content: string;
}

const MAX_EXCERPT = 300;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function excerptOf(text: string): string {
  return collapse(text).slice(0, MAX_EXCERPT);
}

/**
 * 把引用正文切成段落级片段。
 * - 每个 Markdown 标题（#）开启新的 sectionTitle；
 * - 段落之间以空行分隔；
 * - locator 形如「第 2 节 试点范围 / 第 3 段」或「全文 / 第 1 段」。
 */
export function parseReferenceSections(text: string): ParsedReferenceSection[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections: Array<{ title: string; paragraphs: string[] }> = [];
  let currentTitle = '全文';
  let currentParagraphs: string[] = [];
  let buffer: string[] = [];

  const flushParagraph = (): void => {
    const paragraph = buffer.join('\n').trim();
    buffer = [];
    if (paragraph.length > 0) currentParagraphs.push(paragraph);
  };
  const flushSection = (): void => {
    flushParagraph();
    if (currentParagraphs.length > 0) {
      sections.push({ title: currentTitle, paragraphs: currentParagraphs });
    }
    currentParagraphs = [];
  };

  for (const line of lines) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flushSection();
      currentTitle = heading[2].trim();
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    buffer.push(line);
  }
  flushSection();

  const result: ParsedReferenceSection[] = [];
  let paragraphIndex = 0;
  for (const section of sections) {
    section.paragraphs.forEach((paragraph, indexInSection) => {
      paragraphIndex += 1;
      result.push({
        locator: `${section.title} / 第 ${indexInSection + 1} 段`,
        sectionTitle: section.title,
        paragraphIndex,
        excerpt: excerptOf(paragraph),
        content: paragraph,
      });
    });
  }
  return result;
}

/** 在已落库的 sections 上做 @ 检索（locator/section/excerpt/content 全字段匹配）。 */
export function searchReferenceSections<
  T extends { locator: string; sectionTitle: string; excerpt: string; content: string },
>(sections: T[], query: string, limit = 10): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return sections.slice(0, limit);
  const hits: Array<{ section: T; score: number }> = [];
  for (const section of sections) {
    const haystacks = [section.locator, section.sectionTitle, section.excerpt, section.content];
    let score = 0;
    haystacks.forEach((haystack, index) => {
      const weight = [3, 2, 1, 1][index] ?? 1;
      const lower = haystack.toLowerCase();
      if (lower.includes(needle)) score += weight;
      if (lower.startsWith(needle)) score += weight;
    });
    if (score > 0) hits.push({ section, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((hit) => hit.section);
}
