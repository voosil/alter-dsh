/**
 * Slash menu (`/`) for the AST document editor.
 *
 * Typing `/` in an empty paragraph opens a filtered command list. The menu is
 * presentational: the editor owns the open/close lifecycle and the keyboard
 * handling, this module owns the command catalog, the query filter and the
 * rendered list.
 *
 * Every block command replaces the typed `/query` paragraph through the
 * editor chain, so a single undo step restores the paragraph.
 *
 * @module @alter-dsh/space/document/editor/slash-menu
 */
import type { Editor } from '@tiptap/core';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import styles from './slash-menu.module.css';

/** Runtime services a slash command needs from the editor surface. */
export interface SlashCommandContext {
  /** Live editor instance. */
  editor: Editor;
  /** Range covering the typed `/query` text; replaced by the command. */
  range: { from: number; to: number };
  /** Open the OS file picker for an image upload. */
  pickImage: () => void;
  /** Ask the user for a URL and insert a bookmark card. */
  promptBookmark: () => void;
  /** Show a readable notice in the editor status area. */
  notify: (message: string) => void;
}

/** One entry of the slash command list. */
export interface SlashCommand {
  id: string;
  label: string;
  keywords: readonly string[];
  /** Small text glyph shown before the label (no icon dependency). */
  icon: string;
  run: (context: SlashCommandContext) => void;
}

/**
 * Delete the typed `/query` text and return the chain so the command can keep
 * transforming the now-empty paragraph atomically.
 */
function replaceQuery(context: SlashCommandContext) {
  return context.editor.chain().focus().deleteRange(context.range);
}

/**
 * The slash command catalog, in the same order as the old editor's block
 * list. The card commands (`网页链接卡`) are included here; the document-link
 * card is created by pasting an internal Space document link instead.
 */
export const slashCommands: readonly SlashCommand[] = [
  {
    id: 'text',
    label: '正文',
    keywords: ['text', 'paragraph', '正文', '段落', 'p'],
    icon: '¶',
    run: (context) => {
      replaceQuery(context).setParagraph().run();
    },
  },
  {
    id: 'h1',
    label: '标题 1',
    keywords: ['h1', 'heading1', '标题', '一级', 'heading'],
    icon: 'H1',
    run: (context) => {
      replaceQuery(context).setHeading({ level: 1 }).run();
    },
  },
  {
    id: 'h2',
    label: '标题 2',
    keywords: ['h2', 'heading2', '标题', '二级', 'heading'],
    icon: 'H2',
    run: (context) => {
      replaceQuery(context).setHeading({ level: 2 }).run();
    },
  },
  {
    id: 'h3',
    label: '标题 3',
    keywords: ['h3', 'heading3', '标题', '三级', 'heading'],
    icon: 'H3',
    run: (context) => {
      replaceQuery(context).setHeading({ level: 3 }).run();
    },
  },
  {
    id: 'bullet',
    label: '无序列表',
    keywords: ['bullet', 'list', 'ul', '列表', '无序'],
    icon: '•',
    run: (context) => {
      replaceQuery(context).toggleBulletList().run();
    },
  },
  {
    id: 'ordered',
    label: '有序列表',
    keywords: ['number', 'ordered', 'ol', '列表', '有序'],
    icon: '1.',
    run: (context) => {
      replaceQuery(context).toggleOrderedList().run();
    },
  },
  {
    id: 'todo',
    label: '待办',
    keywords: ['todo', 'task', 'checkbox', '待办', '事项', '任务'],
    icon: '☑',
    run: (context) => {
      replaceQuery(context).toggleTaskList().run();
    },
  },
  {
    id: 'quote',
    label: '引用',
    keywords: ['quote', 'blockquote', '引用'],
    icon: '❝',
    run: (context) => {
      replaceQuery(context).toggleBlockquote().run();
    },
  },
  {
    id: 'code',
    label: '代码块',
    keywords: ['code', 'pre', '代码'],
    icon: '</>',
    run: (context) => {
      replaceQuery(context).toggleCodeBlock().run();
    },
  },
  {
    id: 'divider',
    label: '分割线',
    keywords: ['divider', 'hr', '分割线'],
    icon: '—',
    run: (context) => {
      replaceQuery(context).setHorizontalRule().run();
    },
  },
  {
    id: 'table',
    label: '表格',
    keywords: ['table', '表格'],
    icon: '▦',
    run: (context) => {
      replaceQuery(context)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
  {
    id: 'image',
    label: '图片',
    keywords: ['image', 'img', '图片'],
    icon: '🖼',
    run: (context) => {
      replaceQuery(context).run();
      context.pickImage();
    },
  },
  {
    id: 'callout',
    label: '高亮块',
    keywords: ['callout', 'highlight', 'info', '高亮', '提示', '高亮块'],
    icon: '▣',
    run: (context) => {
      replaceQuery(context)
        .insertContent({
          type: 'alterCallout',
          attrs: { tone: 'info' },
          content: [{ type: 'paragraph' }],
        })
        .run();
    },
  },
  {
    id: 'bookmark',
    label: '网页链接卡',
    keywords: ['bookmark', 'link', 'url', '网页', '链接', '链接卡'],
    icon: '🔗',
    run: (context) => {
      replaceQuery(context).run();
      context.promptBookmark();
    },
  },
  {
    id: 'file',
    label: '文件',
    keywords: ['file', 'attachment', '文件', '附件'],
    icon: '📎',
    run: (context) => {
      replaceQuery(context).run();
      context.notify('文件卡片将在 P3 提供，暂不可用');
    },
  },
];

/** Filter the command list by the text typed after `/`. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return [...commands];
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(normalized) ||
      command.keywords.some((keyword) =>
        keyword.toLowerCase().includes(normalized),
      ),
  );
}

/**
 * The `/query` state of the current selection, when the cursor sits in a
 * top-level paragraph whose text starts with `/`.
 */
export function slashQueryAtSelection(
  editor: Editor,
): { text: string; query: string } | undefined {
  if (!editor.isEditable) return undefined;
  const { selection } = editor.state;
  if (!selection.empty) return undefined;
  const { $from } = selection;
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') {
    return undefined;
  }
  const text = $from.parent.textContent;
  if (!text.startsWith('/')) return undefined;
  return { text, query: text.slice(1) };
}

/** Range of the current paragraph's text, used to delete the `/query`. */
export function slashParagraphRange(
  editor: Editor,
): { from: number; to: number } | undefined {
  const { selection } = editor.state;
  const { $from } = selection;
  if ($from.depth !== 1) return undefined;
  const from = $from.start();
  return { from, to: from + $from.parent.content.size };
}

/** Viewport position of the slash menu. */
export interface SlashMenuPosition {
  top: number;
  left: number;
}

/** Open/query/index state owned by the editor surface. */
export interface SlashMenuState extends SlashMenuPosition {
  query: string;
  index: number;
}

const MENU_WIDTH = 288;
const VIEWPORT_MARGIN = 8;

/**
 * Anchor the menu at the caret. `coordsAtPos` needs layout; jsdom (tests) and
 * the rare detached view fall back to a fixed spot below the toolbar.
 */
export function slashMenuPosition(editor: Editor): SlashMenuPosition {
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const width =
      typeof window === 'undefined' ? MENU_WIDTH : window.innerWidth;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(coords.left, width - MENU_WIDTH - VIEWPORT_MARGIN),
    );
    return { top: coords.bottom + 6, left };
  } catch {
    return { top: 96, left: VIEWPORT_MARGIN };
  }
}

/** Props of the rendered slash menu list. */
export interface SlashMenuProps {
  commands: readonly SlashCommand[];
  index: number;
  position: SlashMenuPosition;
  onHover: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}

/** Floating command list; keyboard handling stays in the editor surface. */
export function SlashMenu({
  commands,
  index,
  position,
  onHover,
  onSelect,
}: SlashMenuProps): ReactNode {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={styles.menu}
      style={{ top: position.top, left: position.left }}
      role="listbox"
      aria-label="插入内容"
      data-slash-menu="true"
      onMouseDown={(event) => event.preventDefault()}
    >
      {commands.length === 0 ? (
        <p className={styles.empty}>没有匹配的指令</p>
      ) : (
        commands.map((command, commandIndex) => (
          <button
            key={command.id}
            type="button"
            role="option"
            aria-label={command.label}
            aria-selected={commandIndex === index}
            className={styles.item}
            data-active={commandIndex === index ? 'true' : undefined}
            onMouseEnter={() => onHover(commandIndex)}
            onClick={() => onSelect(command)}
          >
            <span className={styles.icon} aria-hidden="true">
              {command.icon}
            </span>
            <span className={styles.label}>{command.label}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
