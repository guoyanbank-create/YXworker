/**
 * 文档块模型：从 TipTap/ProseMirror JSON 中派生稳定的段落块。
 *
 * 设计要点（对应 PRODUCT_SPEC §5）：
 * - 建议锚点使用稳定 `paragraphId`（编辑器在创建块时写入），文本 quote + hash 作为
 *   冲突校验与安全重基的依据。
 * - 服务端是权威校验方：任何“采纳”都必须在提交后重新抽取块并验证“只有目标段落
 *   发生变化且等于预期新文本”，否则拒绝写入并标记冲突。
 * - 本模块为纯函数，便于单元测试与前后端共享逻辑说明。
 */
import { createHash } from 'node:crypto';
import type { ParagraphBlock } from '../types.js';

export interface PmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: unknown[];
  content?: PmNode[];
}

export interface PmDoc extends PmNode {
  type: 'doc';
  content: PmNode[];
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 抽取节点的纯文本；硬换行映射为 \n，其他结构递归。 */
export function nodeText(node: PmNode | undefined | null): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (!node.content || node.content.length === 0) return '';
  return node.content.map((child) => nodeText(child)).join('');
}

function paragraphIdOf(node: PmNode): string {
  const id = node.attrs?.paragraphId;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem', 'blockquote']);

function classifyListKind(listNode: PmNode): 'bulletList' | 'orderedList' | undefined {
  if (listNode.type === 'bulletList') return 'bulletList';
  if (listNode.type === 'orderedList') return 'orderedList';
  return undefined;
}

export interface ExtractOptions {
  /** 缺失 paragraphId 时使用的稳定兜底 id 前缀。 */
  autoIdPrefix?: string;
}

/**
 * 抽取扁平段落块。支持顶层 paragraph/heading/blockquote，以及 bulletList/orderedList
 * 内部 listItem 里的段落。表格等未在 P0 段落级建议中处理（仍保留在文档 JSON 中）。
 */
export function extractParagraphs(
  contentJson: unknown,
  options: ExtractOptions = {},
): ParagraphBlock[] {
  const doc = contentJson as PmDoc | null | undefined;
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return [];
  const blocks: ParagraphBlock[] = [];
  const autoIdPrefix = options.autoIdPrefix ?? 'auto';
  let chapterIndex = -1;
  let chapterTitle = '（未命名）';

  const push = (
    node: PmNode,
    type: ParagraphBlock['type'],
    extra: Partial<ParagraphBlock> = {},
  ): void => {
    const text = nodeText(node);
    const id = paragraphIdOf(node) || `${autoIdPrefix}_${blocks.length}`;
    blocks.push({
      id,
      index: blocks.length,
      type,
      text,
      hash: hashText(text),
      chapterIndex: Math.max(chapterIndex, 0),
      chapterTitle,
      ...extra,
    });
  };

  const visitTop = (node: PmNode): void => {
    if (!node) return;
    if (node.type === 'heading') {
      const level = typeof node.attrs?.level === 'number' ? (node.attrs.level as number) : 1;
      const text = nodeText(node);
      if (level <= 2) {
        chapterIndex += 1;
        chapterTitle = text || `第 ${chapterIndex + 1} 章`;
      }
      push(node, 'heading', { level });
      return;
    }
    if (node.type === 'paragraph') {
      push(node, 'paragraph');
      return;
    }
    if (node.type === 'blockquote') {
      // 引用块：若内部只有一个段落，作为一个块；否则逐个抽取。
      const inner = (node.content ?? []).filter((child) => child.type === 'paragraph');
      if (inner.length <= 1) {
        push(inner[0] ?? node, 'blockquote');
      } else {
        inner.forEach((child) => push(child, 'blockquote'));
      }
      return;
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      const listKind = classifyListKind(node);
      for (const item of node.content ?? []) {
        if (item.type !== 'listItem') continue;
        for (const child of item.content ?? []) {
          if (child.type === 'paragraph') {
            push(child, 'listItem', { listKind });
          }
        }
      }
      return;
    }
    // 其他节点（表格/图片/自定义块）不产生段落级建议锚点。
  };

  doc.content.forEach(visitTop);
  return blocks;
}

/** 按 id 递归查找段落节点（含列表项内部与引用块内部）。 */
export function findParagraphNode(
  contentJson: unknown,
  paragraphId: string,
): PmNode | null {
  const doc = contentJson as PmDoc | null | undefined;
  if (!doc || !Array.isArray(doc.content)) return null;
  const walk = (node: PmNode): PmNode | null => {
    if (!node) return null;
    if (paragraphIdOf(node) === paragraphId) {
      if (node.type === 'paragraph' || node.type === 'heading') return node;
      if (node.type === 'blockquote') return node;
    }
    for (const child of node.content ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const node of doc.content) {
    const hit = walk(node);
    if (hit) return hit;
  }
  return null;
}

/** 克隆并替换目标段落文本；保留块类型与 attrs（标题层级/列表位置/对齐等）。 */
export function applyParagraphText(
  contentJson: unknown,
  paragraphId: string,
  newText: string,
): { contentJson: PmDoc; applied: boolean } {
  const doc = structuredClone(contentJson) as PmDoc;
  const node = findParagraphNode(doc, paragraphId);
  if (!node) return { contentJson: doc, applied: false };
  if (newText.length === 0) {
    node.content = [];
  } else if (node.type === 'blockquote') {
    // 引用块保持块类型，文本直接放在块内。
    node.content = [{ type: 'paragraph', content: [{ type: 'text', text: newText }] }];
  } else {
    node.content = [{ type: 'text', text: newText }];
  }
  return { contentJson: doc, applied: true };
}

export interface BlockChange {
  id: string;
  before: string;
  after: string;
  kind: 'modified' | 'added' | 'removed';
}

/** 对比两版块列表，返回文本发生变化的段落 id 及变化详情。 */
export function diffBlocks(
  before: ParagraphBlock[],
  after: ParagraphBlock[],
): BlockChange[] {
  const changes: BlockChange[] = [];
  const beforeById = new Map(before.map((b) => [b.id, b]));
  const afterById = new Map(after.map((b) => [b.id, b]));
  for (const block of after) {
    const prev = beforeById.get(block.id);
    if (!prev) {
      changes.push({ id: block.id, before: '', after: block.text, kind: 'added' });
    } else if (prev.text !== block.text) {
      changes.push({ id: block.id, before: prev.text, after: block.text, kind: 'modified' });
    }
  }
  for (const block of before) {
    if (!afterById.has(block.id)) {
      changes.push({ id: block.id, before: block.text, after: '', kind: 'removed' });
    }
  }
  return changes;
}

export interface ApplyValidation {
  ok: boolean;
  reason?: string;
}

/**
 * 校验“目标补丁”是否按预期落地：
 * 1. 段落数量与顺序一致；
 * 2. 除目标段落的文本外，其余段落（类型/层级/文本）完全不变；
 * 3. 目标段落新文本必须等于预期新文本。
 * 这是服务端在采纳写回前的 read-back 校验。
 */
export function validateSingleParagraphChange(
  before: ParagraphBlock[],
  after: ParagraphBlock[],
  targetId: string,
  expectedNewText: string,
): ApplyValidation {
  if (before.length !== after.length) {
    return { ok: false, reason: `段落数量变化（${before.length} → ${after.length}），超出单条建议的修改范围` };
  }
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    if (!a || a.id !== b.id) {
      return { ok: false, reason: `第 ${i + 1} 个段落锚点发生变化，可能被整体重排` };
    }
    const sameShape = a.type === b.type && (a.level ?? 0) === (b.level ?? 0);
    if (!sameShape) {
      return { ok: false, reason: `段落 ${b.id} 的块类型/层级被修改` };
    }
    if (b.id === targetId) {
      if (a.text !== expectedNewText) {
        return {
          ok: false,
          reason: `目标段落文本与预期不一致（期望 ${expectedNewText.length} 字符，实际 ${a.text.length} 字符）`,
        };
      }
    } else if (a.text !== b.text) {
      return { ok: false, reason: `非目标段落 ${b.id} 也被修改，拒绝写入` };
    }
  }
  const target = after.find((b) => b.id === targetId);
  if (!target) return { ok: false, reason: `目标段落 ${targetId} 不存在` };
  return { ok: true };
}

/** 由 `{ chapter: [text...] }` 结构构造 TipTap 文档 JSON（用于种子数据/测试）。 */
export interface SeedChapter {
  title: string;
  paragraphs: string[];
  /** 子标题（三级标题）插在章节标题之后。 */
  subtitle?: string;
}

export function buildContentJson(
  chapters: SeedChapter[],
  idPrefix = 'p',
): PmDoc {
  let seq = 0;
  const paragraphId = (): string => {
    seq += 1;
    return `${idPrefix}_${String(seq).padStart(3, '0')}`;
  };
  const content: PmNode[] = [];
  for (const chapter of chapters) {
    content.push({
      type: 'heading',
      attrs: { level: 1, paragraphId: paragraphId() },
      content: [{ type: 'text', text: chapter.title }],
    });
    if (chapter.subtitle) {
      content.push({
        type: 'heading',
        attrs: { level: 3, paragraphId: paragraphId() },
        content: [{ type: 'text', text: chapter.subtitle }],
      });
    }
    for (const text of chapter.paragraphs) {
      content.push({
        type: 'paragraph',
        attrs: { paragraphId: paragraphId() },
        content: [{ type: 'text', text }],
      });
    }
  }
  return { type: 'doc', content };
}
