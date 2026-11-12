/**
 * Office 式正文编辑器：TipTap（ProseMirror）富文本 + 工具栏。
 *
 * - contentJson 为服务端权威内容；编辑器只在“外部变更”（采纳/回退/冲突刷新）时整体替换。
 * - 每次编辑通过 onUpdate 通知上层做 800ms 防抖自动保存（上层负责乐观锁）。
 * - 新块自动分配稳定 paragraphId（服务端建议锚点）。
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { Content } from '@tiptap/react';
import { createEditorExtensions, normalizeParagraphIds } from './extensions';
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BulletListIcon,
  OrderedListIcon,
  QuoteIcon,
  RedoIcon,
  UndoIcon,
} from '../components/Icons';

export interface EditorPaneProps {
  /** 首次挂载的文档内容（同一 document 生命周期内使用）。 */
  initialContent: unknown;
  /** 外部内容替换令牌：变化时把 contentToApply 写入编辑器。 */
  contentToken: number;
  /** 外部内容（采纳/回退/冲突刷新后的服务端 JSON）。 */
  contentToApply: unknown;
  onUpdate: (editor: Editor) => void;
  onReady: (editor: Editor) => void;
  onContentApplied: () => void;
}

interface ToolButtonProps {
  active?: boolean;
  disabled?: boolean;
  title: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}

function ToolButton({
  active = false,
  disabled = false,
  title,
  testId,
  onClick,
  children,
  className = '',
}: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`toolbar-btn${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
      onMouseDown={(event) => {
        // 保持编辑器焦点/选区，避免点击工具栏后选区丢失。
        event.preventDefault();
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const textAlign = editor.isActive({ textAlign: 'center' })
    ? 'center'
    : editor.isActive({ textAlign: 'right' })
      ? 'right'
      : editor.isActive({ textAlign: 'justify' })
        ? 'justify'
        : 'left';

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="正文格式工具栏" data-testid="editor-toolbar">
      <div className="toolbar-group">
        <ToolButton
          title="撤销"
          testId="btn-undo"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
        >
          <UndoIcon />
        </ToolButton>
        <ToolButton
          title="重做"
          testId="btn-redo"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
        >
          <RedoIcon />
        </ToolButton>
      </div>
      <span className="toolbar-sep" />
      <div className="toolbar-group">
        <ToolButton
          title="正文"
          testId="btn-paragraph"
          active={editor.isActive('paragraph')}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >
          <span className="tool-text">正文</span>
        </ToolButton>
        {([1, 2, 3] as const).map((level) => (
          <ToolButton
            key={level}
            title={`标题 ${level}`}
            testId={`btn-heading-${level}`}
            active={editor.isActive('heading', { level })}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          >
            <span className="tool-text is-heading">H{level}</span>
          </ToolButton>
        ))}
      </div>
      <span className="toolbar-sep" />
      <div className="toolbar-group">
        <ToolButton
          title="加粗"
          testId="btn-bold"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <span className="tool-text is-bold">B</span>
        </ToolButton>
        <ToolButton
          title="斜体"
          testId="btn-italic"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <span className="tool-text is-italic">I</span>
        </ToolButton>
        <ToolButton
          title="下划线"
          testId="btn-underline"
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <span className="tool-text is-underline">U</span>
        </ToolButton>
        <ToolButton
          title="删除线"
          testId="btn-strike"
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <span className="tool-text is-strike">S</span>
        </ToolButton>
      </div>
      <span className="toolbar-sep" />
      <div className="toolbar-group">
        <ToolButton
          title="有序列表"
          testId="btn-ordered-list"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <OrderedListIcon />
        </ToolButton>
        <ToolButton
          title="无序列表"
          testId="btn-bullet-list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <BulletListIcon />
        </ToolButton>
        <ToolButton
          title="引用"
          testId="btn-blockquote"
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <QuoteIcon />
        </ToolButton>
      </div>
      <span className="toolbar-sep" />
      <div className="toolbar-group">
        <ToolButton
          title="左对齐"
          testId="btn-align-left"
          active={textAlign === 'left'}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
        >
          <AlignLeftIcon />
        </ToolButton>
        <ToolButton
          title="居中对齐"
          testId="btn-align-center"
          active={textAlign === 'center'}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
        >
          <AlignCenterIcon />
        </ToolButton>
        <ToolButton
          title="右对齐"
          testId="btn-align-right"
          active={textAlign === 'right'}
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
        >
          <AlignRightIcon />
        </ToolButton>
        <ToolButton
          title="两端对齐"
          testId="btn-align-justify"
          active={textAlign === 'justify'}
          onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        >
          <AlignJustifyIcon />
        </ToolButton>
      </div>
    </div>
  );
}

export function EditorPane({
  initialContent,
  contentToken,
  contentToApply,
  onUpdate,
  onReady,
  onContentApplied,
}: EditorPaneProps) {
  const onUpdateRef = useRef(onUpdate);
  const onReadyRef = useRef(onReady);
  const onAppliedRef = useRef(onContentApplied);
  const suppressRef = useRef(false);
  const lastTokenRef = useRef(contentToken);
  const normalizeScheduledRef = useRef(false);
  const readyEditorRef = useRef<Editor | null>(null);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
    onReadyRef.current = onReady;
    onAppliedRef.current = onContentApplied;
  }, [onUpdate, onReady, onContentApplied]);

  function markReady(instance: Editor): void {
    if (instance.isDestroyed) return;
    if (readyEditorRef.current === instance) return;
    readyEditorRef.current = instance;
    normalizeParagraphIds(instance);
    onReadyRef.current(instance);
  }

  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: initialContent as Content,
    // 避免在 render 阶段创建 editor（React StrictMode 下会重复实例化），改在挂载后创建。
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: 'yx-prose',
        'data-testid': 'editor-surface',
        spellcheck: 'false',
      },
    },
    onCreate: ({ editor: instance }) => {
      markReady(instance);
    },
    onUpdate: ({ editor: instance }) => {
      if (suppressRef.current) return;
      // 异步补齐新块 id，避免在 onUpdate 内同步 dispatch 造成重入。
      if (!normalizeScheduledRef.current) {
        normalizeScheduledRef.current = true;
        queueMicrotask(() => {
          normalizeScheduledRef.current = false;
          if (instance.isDestroyed || suppressRef.current) return;
          normalizeParagraphIds(instance);
        });
      }
      onUpdateRef.current(instance);
    },
  });

  // onCreate 在部分 React 严格模式/挂载时序下可能晚于首帧；此处兜底把编辑器实例交给上层。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    markReady(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (contentToken === lastTokenRef.current) return;
    lastTokenRef.current = contentToken;
    suppressRef.current = true;
    editor.commands.setContent(contentToApply as Content, { emitUpdate: false });
    normalizeParagraphIds(editor);
    suppressRef.current = false;
    onAppliedRef.current();
  }, [contentToken, contentToApply, editor]);

  return (
    <div className="editor-pane" data-testid="editor-pane">
      {editor ? <Toolbar editor={editor} /> : <div className="editor-toolbar is-placeholder" />}
      <div className="editor-scroll">
        <div className="editor-paper">
          <div data-testid="editor">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 只读文档预览（版本查看）：同一套富文本渲染，但不可编辑。 */
export function ReadonlyEditor({ content }: { content: unknown }) {
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: content as Content,
    editable: false,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
  });

  return (
    <div className="readonly-document">
      <EditorContent editor={editor} />
    </div>
  );
}
