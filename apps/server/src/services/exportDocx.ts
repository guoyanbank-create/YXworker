/**
 * DOCX 导出：把服务端权威 TipTap JSON 渲染为可编辑的 Word 文档。
 *
 * 支持 P0 编辑器块：标题层级、正文、列表（有序/无序）、引用块、对齐、
 * 粗体/斜体/下划线/删除线/行内代码。由 `docx` 包在内存中生成，不落盘保存二进制。
 *
 * P2 模板（docs/API_CONTRACT.md P2-8 / 任务要求）：模板只影响文字版式，不改正文内容：
 * - `gov` 政务公文：一级标题方正小标宋居中、章节黑体、正文仿宋_GB2312、
 *   28pt 固定行距（line=560 twips / lineRule=exact）、A4 公文页边距（37/35/28/26mm）；
 * - `tech` 技术方案：微软雅黑标题与正文、1.5 倍行距（line=360 twips / lineRule=auto）、A4 常规页边距。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type {
  INumberingOptions,
  IParagraphOptions,
  ISpacingProperties,
} from 'docx';
import type { PmDoc, PmNode } from '../domain/paragraphs.js';
import { nodeText } from '../domain/paragraphs.js';
import { badRequest } from '../errors.js';
import type { DocumentTemplateInfo } from '../types.js';
import { assertContentJson } from './documentsService.js';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type DocumentTemplateId = 'gov' | 'tech';

/** `GET /api/templates` 返回的模板信息（与 `DocumentTemplateInfo` 契约一致）。 */
export const DOCUMENT_TEMPLATES: readonly DocumentTemplateInfo[] = [
  {
    id: 'gov',
    name: '政务公文',
    description:
      'A4 公文版式：标题方正小标宋居中、章节黑体、正文仿宋_GB2312、28pt 固定行距、公文页边距（上 37mm/下 35mm/左 28mm/右 26mm）。',
  },
  {
    id: 'tech',
    name: '技术方案',
    description: '技术方案版式：微软雅黑标题与正文、1.5 倍行距、A4 常规页边距。',
  },
];

const ORDERED_LIST_REFERENCE = 'yxworker-ordered-list';
const MAX_LIST_LEVEL = 8;

type DocxAlignment = (typeof AlignmentType)[keyof typeof AlignmentType];
type DocxHeading = (typeof HeadingLevel)[keyof typeof HeadingLevel];
type ParagraphOptions = IParagraphOptions;

const ALIGNMENTS: Record<string, DocxAlignment> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

const HEADINGS: Record<number, DocxHeading> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/** Word 字体三属性（西文/高位 ANSI/东亚）。 */
interface FontSpec {
  ascii: string;
  hAnsi: string;
  eastAsia: string;
}

interface HeadingStyle {
  font: FontSpec;
  size: number;
  bold: boolean;
  alignment: DocxAlignment;
}

interface TemplateSpec {
  id: DocumentTemplateId;
  body: { font: FontSpec; size: number };
  headings: (level: number) => HeadingStyle;
  bodySpacing: ISpacingProperties;
  headingSpacing: ISpacingProperties;
  page: { width: number; height: number; margin: { top: number; right: number; bottom: number; left: number } };
}

const CJK_SERIF: FontSpec = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  eastAsia: '仿宋_GB2312',
};
const CJK_SONG_TITLE: FontSpec = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  eastAsia: '方正小标宋简体',
};
const CJK_HEI: FontSpec = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  eastAsia: '黑体',
};
const YAHEI: FontSpec = {
  ascii: 'Microsoft YaHei',
  hAnsi: 'Microsoft YaHei',
  eastAsia: '微软雅黑',
};

/** A4 尺寸（twips）：210mm × 297mm。 */
const A4 = { width: 11906, height: 16838 };

const TEMPLATE_SPECS: Record<DocumentTemplateId, TemplateSpec> = {
  gov: {
    id: 'gov',
    body: { font: CJK_SERIF, size: 32 }, // 三号（16pt）仿宋
    headings: (level) =>
      level === 1
        ? { font: CJK_SONG_TITLE, size: 44, bold: false, alignment: AlignmentType.CENTER }
        : { font: CJK_HEI, size: 32, bold: false, alignment: AlignmentType.LEFT },
    // 28pt 固定行距：28pt × 20 twips/pt = 560。
    bodySpacing: { line: 560, lineRule: LineRuleType.EXACT, after: 0 },
    headingSpacing: { line: 560, lineRule: LineRuleType.EXACT, before: 0, after: 0 },
    // A4 公文页边距：上 37mm、下 35mm、左 28mm、右 26mm。
    page: {
      ...A4,
      margin: { top: 2098, right: 1474, bottom: 1984, left: 1587 },
    },
  },
  tech: {
    id: 'tech',
    body: { font: YAHEI, size: 22 }, // 11pt 微软雅黑
    headings: (level) => ({
      font: YAHEI,
      size: level === 1 ? 32 : level === 2 ? 28 : level === 3 ? 24 : 22,
      bold: true,
      alignment: AlignmentType.LEFT,
    }),
    // 1.5 倍行距：12pt 字号下 line=360 twips、lineRule=auto。
    bodySpacing: { line: 360, lineRule: LineRuleType.AUTO, after: 120 },
    headingSpacing: { line: 360, lineRule: LineRuleType.AUTO, before: 240, after: 120 },
    page: {
      ...A4,
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    },
  },
};

/** 解析模板 id；未知模板抛 400 validation_error。 */
export function resolveTemplateSpec(templateId: string = 'tech'): TemplateSpec {
  const spec = TEMPLATE_SPECS[templateId as DocumentTemplateId];
  if (!spec) {
    throw badRequest('validation_error', `未知导出模板: ${templateId}`, {
      allowed: Object.keys(TEMPLATE_SPECS),
    });
  }
  return spec;
}

interface RunStyle {
  bold: boolean;
  italics: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
}

const NO_STYLE: RunStyle = {
  bold: false,
  italics: false,
  underline: false,
  strike: false,
  code: false,
};

/** 合并节点上的 mark（bold/italic/underline/strike/code）到继承样式。 */
function styleWithMarks(base: RunStyle, marks: unknown): RunStyle {
  if (!Array.isArray(marks) || marks.length === 0) return base;
  const next: RunStyle = { ...base };
  for (const mark of marks) {
    const type = (mark as { type?: unknown } | null)?.type;
    if (type === 'bold') next.bold = true;
    else if (type === 'italic') next.italics = true;
    else if (type === 'underline') next.underline = true;
    else if (type === 'strike') next.strike = true;
    else if (type === 'code') next.code = true;
  }
  return next;
}

/** 段落渲染上下文：模板字体/字号/粗体/行距 + 内容块自身样式。 */
interface ParagraphContext {
  font: FontSpec;
  size: number;
  /** 模板级强制粗体（技术方案标题）。 */
  bold: boolean;
  baseStyle: RunStyle;
  heading?: DocxHeading;
  alignment?: DocxAlignment;
  spacing: ISpacingProperties;
}

function bodyContext(
  template: TemplateSpec,
  baseStyle: RunStyle = NO_STYLE,
): ParagraphContext {
  return {
    font: template.body.font,
    size: template.body.size,
    bold: false,
    baseStyle,
    spacing: template.bodySpacing,
  };
}

function textRun(text: string, style: RunStyle, ctx: ParagraphContext): TextRun {
  const bold = style.bold || ctx.bold;
  return new TextRun({
    text,
    font: ctx.font,
    size: ctx.size,
    ...(bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.underline ? { underline: {} } : {}),
    ...(style.strike ? { strike: true } : {}),
    // 行内代码保留等宽字体 + 浅灰底，避免被模板正文字体覆盖。
    ...(style.code ? { font: 'Consolas', shading: { fill: 'F2F2F2' } } : {}),
  });
}

/** 行内节点 → TextRun 列表（处理文本、硬换行、行内图片占位）。 */
function inlineRuns(node: PmNode, ctx: ParagraphContext): TextRun[] {
  const style = styleWithMarks(ctx.baseStyle, node.marks);
  if (node.type === 'text') return [textRun(node.text ?? '', style, ctx)];
  if (node.type === 'hardBreak') return [new TextRun({ break: 1 })];
  if (node.type === 'image') return [textRun('[图片]', style, ctx)];
  const runs: TextRun[] = [];
  for (const child of node.content ?? []) runs.push(...inlineRuns(child, ctx));
  return runs;
}

function alignmentOf(node: PmNode): DocxAlignment | undefined {
  const value = node.attrs?.textAlign;
  return typeof value === 'string' ? ALIGNMENTS[value] : undefined;
}

function headingLevelOf(node: PmNode): number {
  const level = node.attrs?.level;
  if (typeof level !== 'number') return 1;
  return Math.min(Math.max(Math.trunc(level), 1), 6);
}

/** 段落/标题节点 → Word 段落（保留块类型、标题层级、对齐与模板行距）。 */
function blockParagraph(
  node: PmNode,
  ctx: ParagraphContext,
  extra: Partial<ParagraphOptions> = {},
): Paragraph {
  const alignment = alignmentOf(node) ?? ctx.alignment;
  return new Paragraph({
    children: inlineRuns(node, ctx),
    ...(alignment ? { alignment } : {}),
    ...(ctx.heading ? { heading: ctx.heading } : {}),
    spacing: ctx.spacing,
    ...extra,
  });
}

function blockquoteParagraphs(node: PmNode, template: TemplateSpec): Paragraph[] {
  const ctx = bodyContext(template, { ...NO_STYLE, italics: true });
  const inner = (node.content ?? []).filter((child) => child.type === 'paragraph');
  const paragraphs: PmNode[] =
    inner.length > 0 ? inner : [{ type: 'paragraph', content: node.content ?? [] }];
  return paragraphs.map((paragraph) =>
    blockParagraph(paragraph, ctx, {
      indent: { left: 720 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 },
      },
    }),
  );
}

/** 列表节点 → 带项目符号/编号与缩进层级的 Word 段落。 */
function listParagraphs(
  listNode: PmNode,
  level: number,
  template: TemplateSpec,
): Paragraph[] {
  const clampedLevel = Math.min(Math.max(level, 0), MAX_LIST_LEVEL);
  const ordered = listNode.type === 'orderedList';
  const listFormat: Partial<ParagraphOptions> = ordered
    ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: clampedLevel } }
    : { bullet: { level: clampedLevel } };
  const ctx = bodyContext(template);
  const paragraphs: Paragraph[] = [];
  for (const item of listNode.content ?? []) {
    if (item.type !== 'listItem') continue;
    for (const child of item.content ?? []) {
      if (child.type === 'paragraph') {
        paragraphs.push(blockParagraph(child, ctx, listFormat));
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        paragraphs.push(...listParagraphs(child, clampedLevel + 1, template));
      } else {
        const text = nodeText(child).trim();
        if (text.length > 0) {
          paragraphs.push(
            new Paragraph({ children: [textRun(text, NO_STYLE, ctx)], spacing: ctx.spacing }),
          );
        }
      }
    }
  }
  return paragraphs;
}

function buildChildren(doc: PmDoc, template: TemplateSpec): Paragraph[] {
  const children: Paragraph[] = [];
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case 'heading': {
        const level = headingLevelOf(node);
        const headingStyle = template.headings(level);
        children.push(
          blockParagraph(node, {
            font: headingStyle.font,
            size: headingStyle.size,
            bold: headingStyle.bold,
            baseStyle: NO_STYLE,
            heading: HEADINGS[level],
            alignment: headingStyle.alignment,
            spacing: template.headingSpacing,
          }),
        );
        break;
      }
      case 'paragraph':
        children.push(blockParagraph(node, bodyContext(template)));
        break;
      case 'blockquote':
        children.push(...blockquoteParagraphs(node, template));
        break;
      case 'bulletList':
      case 'orderedList':
        children.push(...listParagraphs(node, 0, template));
        break;
      case 'horizontalRule':
        children.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF' } },
          }),
        );
        break;
      case 'table':
        // P0 段落级导出不展开表格（表格仍保留在文档 JSON 中）。
        break;
      default: {
        const text = nodeText(node).trim();
        if (text.length > 0) {
          const ctx = bodyContext(template);
          children.push(
            new Paragraph({ children: [textRun(text, NO_STYLE, ctx)], spacing: ctx.spacing }),
          );
        }
        break;
      }
    }
  }
  if (children.length === 0) children.push(new Paragraph({ children: [] }));
  return children;
}

function numberingConfig(): INumberingOptions {
  return {
    config: [
      {
        reference: ORDERED_LIST_REFERENCE,
        levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 420 + level * 420, hanging: 360 } } },
        })),
      },
    ],
  };
}

/** 由 TipTap JSON 生成 DOCX 二进制（不落盘；模板只改版式不改正文）。 */
export async function buildDocxBuffer(
  contentJson: unknown,
  templateId: string = 'tech',
): Promise<Buffer> {
  const doc = assertContentJson(contentJson);
  const template = resolveTemplateSpec(templateId);
  const document = new Document({
    numbering: numberingConfig(),
    styles: {
      default: {
        document: {
          run: {
            font: {
              ascii: template.body.font.ascii,
              hAnsi: template.body.font.hAnsi,
              eastAsia: template.body.font.eastAsia,
            },
            size: template.body.size,
          },
          paragraph: { spacing: template.bodySpacing },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: template.page.width, height: template.page.height },
            margin: template.page.margin,
          },
        },
        children: buildChildren(doc, template),
      },
    ],
  });
  return Packer.toBuffer(document);
}

/** 生成 Content-Disposition：ASCII 回退 + RFC 5987 UTF-8 文件名（中文标题可用）。 */
export function contentDispositionFor(title: string): string {
  const safeName =
    title
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'document';
  const filename = `${safeName}.docx`;
  const asciiFallback = /^[\x20-\x7E]+$/.test(filename) ? filename : 'yxworker-document.docx';
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // filename* 放在前面：RFC 6266 中它优先于 filename，前端解析时也能直接命中中文标题。
  return `attachment; filename*=UTF-8''${encoded}; filename="${asciiFallback}"`;
}
