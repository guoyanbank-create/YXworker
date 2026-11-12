/**
 * DOCX 导出：把服务端权威 TipTap JSON 渲染为可编辑的 Word 文档。
 *
 * 支持 P0 编辑器块：标题层级、正文、列表（有序/无序）、引用块、对齐、
 * 粗体/斜体/下划线/删除线/行内代码。由 `docx` 包在内存中生成，不落盘保存二进制。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type { INumberingOptions, IParagraphOptions } from 'docx';
import type { PmDoc, PmNode } from '../domain/paragraphs.js';
import { nodeText } from '../domain/paragraphs.js';
import { assertContentJson } from './documentsService.js';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

function textRun(text: string, style: RunStyle): TextRun {
  return new TextRun({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.underline ? { underline: {} } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code ? { font: 'Consolas', shading: { fill: 'F2F2F2' } } : {}),
  });
}

/** 行内节点 → TextRun 列表（处理文本、硬换行、行内图片占位）。 */
function inlineRuns(node: PmNode, base: RunStyle): TextRun[] {
  const style = styleWithMarks(base, node.marks);
  if (node.type === 'text') return [textRun(node.text ?? '', style)];
  if (node.type === 'hardBreak') return [new TextRun({ break: 1 })];
  if (node.type === 'image') return [textRun('[图片]', style)];
  const runs: TextRun[] = [];
  for (const child of node.content ?? []) runs.push(...inlineRuns(child, style));
  return runs;
}

function alignmentOf(node: PmNode): DocxAlignment | undefined {
  const value = node.attrs?.textAlign;
  return typeof value === 'string' ? ALIGNMENTS[value] : undefined;
}

function headingOf(node: PmNode): DocxHeading | undefined {
  const level = node.attrs?.level;
  if (typeof level !== 'number') return HeadingLevel.HEADING_1;
  const clamped = Math.min(Math.max(Math.trunc(level), 1), 6);
  return HEADINGS[clamped];
}

/** 段落/标题节点 → Word 段落（保留块类型、标题层级与对齐）。 */
function blockParagraph(
  node: PmNode,
  base: RunStyle,
  extra: Partial<ParagraphOptions> = {},
): Paragraph {
  const alignment = alignmentOf(node);
  const heading = node.type === 'heading' ? headingOf(node) : undefined;
  return new Paragraph({
    children: inlineRuns(node, base),
    ...(alignment ? { alignment } : {}),
    ...(heading ? { heading } : {}),
    ...extra,
  });
}

function blockquoteParagraphs(node: PmNode, base: RunStyle): Paragraph[] {
  const inner = (node.content ?? []).filter((child) => child.type === 'paragraph');
  const paragraphs: PmNode[] =
    inner.length > 0 ? inner : [{ type: 'paragraph', content: node.content ?? [] }];
  return paragraphs.map((paragraph) =>
    blockParagraph(paragraph, { ...base, italics: true }, {
      indent: { left: 720 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 },
      },
    }),
  );
}

/** 列表节点 → 带项目符号/编号与缩进层级的 Word 段落。 */
function listParagraphs(listNode: PmNode, level: number, base: RunStyle): Paragraph[] {
  const clampedLevel = Math.min(Math.max(level, 0), MAX_LIST_LEVEL);
  const ordered = listNode.type === 'orderedList';
  const listFormat: Partial<ParagraphOptions> = ordered
    ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: clampedLevel } }
    : { bullet: { level: clampedLevel } };
  const paragraphs: Paragraph[] = [];
  for (const item of listNode.content ?? []) {
    if (item.type !== 'listItem') continue;
    for (const child of item.content ?? []) {
      if (child.type === 'paragraph') {
        paragraphs.push(blockParagraph(child, base, listFormat));
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        paragraphs.push(...listParagraphs(child, clampedLevel + 1, base));
      } else {
        const text = nodeText(child).trim();
        if (text.length > 0) paragraphs.push(new Paragraph({ children: [textRun(text, base)] }));
      }
    }
  }
  return paragraphs;
}

function buildChildren(doc: PmDoc): Paragraph[] {
  const children: Paragraph[] = [];
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case 'heading':
      case 'paragraph':
        children.push(blockParagraph(node, NO_STYLE));
        break;
      case 'blockquote':
        children.push(...blockquoteParagraphs(node, NO_STYLE));
        break;
      case 'bulletList':
      case 'orderedList':
        children.push(...listParagraphs(node, 0, NO_STYLE));
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
        if (text.length > 0) children.push(new Paragraph({ children: [textRun(text, NO_STYLE)] }));
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

/** 由 TipTap JSON 生成 DOCX 二进制（不落盘）。 */
export async function buildDocxBuffer(contentJson: unknown): Promise<Buffer> {
  const doc = assertContentJson(contentJson);
  const document = new Document({
    numbering: numberingConfig(),
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '宋体' },
            size: 22,
          },
          paragraph: { spacing: { after: 120, line: 320 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4（twips）
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children: buildChildren(doc),
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
