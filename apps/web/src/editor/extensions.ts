/**
 * 编辑器扩展：为段落/标题节点生成并保持稳定 `paragraphId`。
 *
 * 契约（docs/API_CONTRACT.md §3.4）：
 * - contentJson 的段落/标题节点必须带 `paragraphId`；
 * - 服务端以该 id 作为建议锚点、hash 冲突校验与单段落读回校验的定位依据；
 * - 编辑器为新块自动分配 id，并保证已有块的 id 不因编辑而改变。
 */
import { Extension, type Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';

/** 生成前端新块的稳定 id（与后端 id 前缀风格一致，避免与既有 id 冲突）。 */
export function createParagraphId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `p_${Date.now().toString(36)}${random}`;
}

/**
 * 全局属性扩展：在 paragraph / heading 上读写 `paragraphId`。
 * - 渲染为 `data-paragraph-id`，供“定位”滚动/高亮与测试选择；
 * - 默认 null，由 normalizeParagraphIds 补齐。
 */
export const ParagraphIdAttribute = Extension.create({
  name: 'paragraphIdAttribute',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          paragraphId: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-paragraph-id'),
            renderHTML: (attributes: Record<string, unknown>) => {
              const id = attributes.paragraphId;
              return typeof id === 'string' && id.length > 0
                ? { 'data-paragraph-id': id }
                : {};
            },
          },
        },
      },
    ];
  },
});

/**
 * 为文档中所有缺少 paragraphId 的段落/标题补齐 id。
 * 通过一次独立 transaction 写回，避免在 onCreate/onUpdate 中递归触发。
 * 返回是否发生了补写，便于调用方判断是否需要保存。
 */
export function normalizeParagraphIds(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  const { doc, tr } = editor.state;
  const seen = new Set<string>();
  const updates: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
    const currentId = node.attrs.paragraphId;
    // 缺失 id 需要补；重复 id 必须重新分配（TipTap 在 splitBlock 时会把 attrs 复制给新块，
    // 若不修正会出现两个同 id 的段落锚点，服务端的 baseHash/冲突校验将无法定位）。
    if (typeof currentId === 'string' && currentId.length > 0 && !seen.has(currentId)) {
      seen.add(currentId);
      return;
    }
    updates.push({ pos, attrs: { ...node.attrs, paragraphId: createParagraphId() } });
  });
  if (updates.length === 0) return false;
  for (const item of updates) {
    tr.setNodeMarkup(item.pos, undefined, item.attrs);
  }
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  return true;
}

/**
 * 批注定位高亮目标（P1-2 闭环）：
 * - paragraphId：目标段落锚点，始终按 id 查找（不修改正文）；
 * - from/to：段内选中范围的绝对文档位置，用于高亮“选中范围”（可选）；
 * - conflict：冲突提案用红色样式区分。
 */
export interface LocateTarget {
  paragraphId: string;
  from?: number | null;
  to?: number | null;
  conflict?: boolean;
}

/** 定位高亮：用 ProseMirror 装饰（decoration）标记目标段落/范围，不修改文档 JSON、不触发自动保存。 */
const locatePluginKey = new PluginKey<LocateTarget | null>('locateHighlight');

export const LocateHighlight = Extension.create({
  name: 'locateHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: locatePluginKey,
        state: {
          init: (): LocateTarget | null => null,
          apply(tr, value) {
            const meta = tr.getMeta(locatePluginKey) as LocateTarget | null | undefined;
            if (meta !== undefined) return meta;
            return value;
          },
        },
        props: {
          decorations(state) {
            const target = locatePluginKey.getState(state);
            if (!target) return null;
            let foundPos = -1;
            let foundSize = 0;
            state.doc.descendants((node, pos) => {
              if (node.attrs.paragraphId === target.paragraphId) {
                foundPos = pos;
                foundSize = node.nodeSize;
                return false;
              }
              return true;
            });
            if (foundPos < 0) return null;
            const decorations: Decoration[] = [
              Decoration.node(foundPos, foundPos + foundSize, {
                class: target.conflict ? 'is-located is-located-conflict' : 'is-located',
                'data-testid': 'proposal-highlight',
                'data-conflict': target.conflict ? 'true' : 'false',
              }),
            ];
            if (target.from != null && target.to != null && target.to > target.from) {
              const min = foundPos + 1;
              const max = foundPos + foundSize - 1;
              const from = Math.max(min, Math.min(target.from, max));
              const to = Math.max(from, Math.min(target.to, max));
              if (to > from) {
                decorations.push(
                  Decoration.inline(from, to, {
                    class: target.conflict
                      ? 'is-located-range is-located-conflict'
                      : 'is-located-range',
                  }),
                );
              }
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/** 高亮指定段落/范围（传 null 清除）。纯装饰事务，不改变正文，不触发保存。 */
export function setLocateHighlight(editor: Editor, target: LocateTarget | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(locatePluginKey, target));
}

/** 编辑器扩展集合（StarterKit 已含 Link/Underline，这里显式替换为配置化扩展）。 */
export function createEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true },
      underline: false,
    }),
    Underline,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ParagraphIdAttribute,
    LocateHighlight,
  ];
}
