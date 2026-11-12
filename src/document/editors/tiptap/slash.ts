/**
 * Slash menu for the AST-native kernel.
 *
 * Behavior parity with the frozen editor: typing `/` as the first character of
 * a line opens the block menu, further typing filters it, Arrow keys move the
 * highlight, Enter/Click runs the command, Escape closes it, and choosing an
 * item removes the `/query` text. The menu is a plain DOM element positioned at
 * the caret and styled by the frozen stylesheet (`.slashMenu` / `.slashItem` /
 * `.slashIcon`), so its look is not re-invented here.
 *
 * Every command maps onto one ProseMirror command; nothing here parses or
 * rewrites HTML.
 *
 * @module @alter-dsh/space/document/editors/tiptap/slash
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { filterSlashCommands, type SlashCommand } from '../slash-commands';

/** Plugin key so the menu state can be read back from the view. */
export const slashPluginKey = new PluginKey<SlashMenuState>('alterSpaceSlash');

/** Open-menu state. */
export interface SlashMenuState {
  /** Document position of the `/` character. */
  from: number;
  /** Document position just after the typed query. */
  to: number;
  /** Current filter query (text after the `/`). */
  query: string;
  /** Highlighted index in the filtered command list. */
  index: number;
}

/** Options the kernel passes to the slash extension. */
export interface SlashOptions {
  /** Open the asset picker; the page wires this to its upload flow. */
  onPickAsset?: (kind: 'image' | 'file') => void;
}

/** Closed state (ProseMirror plugin state is not nullable in its types). */
const CLOSED = null as unknown as SlashMenuState;

/** Typed accessor for the plugin state. */
export function readSlashState(
  view: EditorView,
): SlashMenuState | null {
  return slashPluginKey.getState(view.state) ?? null;
}

/** Run one command against the current line, then drop the `/query` text. */
function applyCommand(
  editor: Editor,
  command: SlashCommand,
  state: SlashMenuState,
  options: SlashOptions,
): void {
  const base = editor.chain().focus().deleteRange({ from: state.from, to: state.to });
  if (command.kind === 'table') {
    base.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    return;
  }
  if (command.kind === 'image' || command.kind === 'file') {
    base.run();
    options.onPickAsset?.(command.kind);
    return;
  }
  switch (command.node) {
    case 'paragraph':
      base.setParagraph().run();
      return;
    case 'heading':
      base.setHeading({ level: (command.level ?? 1) as 1 | 2 | 3 }).run();
      return;
    case 'bulletList':
      base.toggleBulletList().run();
      return;
    case 'orderedList':
      base.toggleOrderedList().run();
      return;
    case 'taskList':
      base.toggleTaskList().run();
      return;
    case 'blockquote':
      base.toggleBlockquote().run();
      return;
    case 'codeBlock':
      base.toggleCodeBlock().run();
      return;
    case 'divider':
      // A divider replaces the (now empty) line and leaves a paragraph to type
      // in, mirroring the frozen editor's "replace line with hr + p".
      base
        .insertContent([
          { type: 'divider', attrs: { id: null } },
          { type: 'paragraph', attrs: { id: null } },
        ])
        .run();
      return;
    default:
      base.run();
  }
}

/** Build the menu DOM matching the frozen stylesheet's class names. */
function buildMenu(
  view: EditorView,
  state: SlashMenuState,
  editor: Editor,
  options: SlashOptions,
): HTMLElement {
  const commands = filterSlashCommands(state.query);
  const menu = document.createElement('div');
  menu.className = 'slashMenu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', '插入内容');
  // Keep the caret while clicking inside the menu (frozen behavior).
  menu.addEventListener('mousedown', (event) => event.preventDefault());

  // Position at the caret; fixed positioning mirrors the frozen menu.
  const coords = view.coordsAtPos(state.from);
  menu.style.position = 'fixed';
  menu.style.top = `${coords.bottom + 6}px`;
  menu.style.left = `${coords.left}px`;

  if (commands.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'slashEmpty';
    empty.textContent = '没有匹配的块';
    menu.append(empty);
    return menu;
  }

  commands.forEach((command, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === state.index));
    item.className = 'slashItem';
    if (index === state.index) item.dataset['active'] = '';
    item.dataset['commandId'] = command.id;
    item.textContent = command.label;
    item.addEventListener('mouseenter', () => {
      const current = readSlashState(view);
      if (current === null || current.index === index) return;
      view.dispatch(view.state.tr.setMeta(slashPluginKey, { ...current, index }));
    });
    item.addEventListener('click', () => {
      const current = readSlashState(view);
      if (current === null) return;
      closeMenu(view);
      applyCommand(editor, command, current, options);
    });
    menu.append(item);
  });
  return menu;
}

/** Close the menu (state + DOM). */
function closeMenu(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(slashPluginKey, CLOSED));
}

/** `true` when the `/` lives at the start of its textblock. */
function opensAtLineStart(view: EditorView, state: SlashMenuState): boolean {
  // `state.from` already points at the `/` itself; anything but offset 0 means
  // the slash is preceded by text on the same line, which must not open a menu.
  const $from = view.state.doc.resolve(state.from);
  return $from.parent.isTextblock && $from.parentOffset === 0;
}

/**
 * The slash-menu extension.
 *
 * The editor instance is resolved inside `addProseMirrorPlugins` (`this.editor`),
 * which runs while the editor is being constructed; `onCreate` fires only after
 * the plugin view already exists, so capturing it there would leave the first
 * menu unrenderable.
 */
export function createSlashExtension(options: SlashOptions = {}): Extension {
  return Extension.create({
    name: 'alterSpaceSlash',
    addProseMirrorPlugins() {
      const editorRef = this.editor;
      return [
        new Plugin<SlashMenuState>({
          key: slashPluginKey,
          state: {
            init: () => CLOSED,
            apply(transaction, previous) {
              const meta = transaction.getMeta(slashPluginKey) as
                | SlashMenuState
                | null
                | undefined;
              if (meta === null) return CLOSED;
              if (meta !== undefined) return meta;

              const selection = transaction.selection;
              if (!selection.empty) return CLOSED;
              const $pos = selection.$from;
              if (!$pos.parent.isTextblock) return CLOSED;
              const textBefore = $pos.parent.textBetween(
                0,
                $pos.parentOffset,
                undefined,
                '\ufffc',
              );
              const slashIndex = textBefore.indexOf('/');
              if (slashIndex !== 0) return CLOSED;
              return {
                from: $pos.start() + slashIndex,
                to: selection.from,
                query: textBefore.slice(slashIndex + 1),
                // A changed query resets the highlight to the first item.
                index:
                  previous !== null && previous.query === textBefore.slice(1)
                    ? previous.index
                    : 0,
              };
            },
          },
          props: {
            handleKeyDown(view, event) {
              const state = readSlashState(view);
              if (state === null) return false;
              const commands = filterSlashCommands(state.query);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (commands.length === 0) return true;
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const index =
                  (state.index + delta + commands.length) % commands.length;
                view.dispatch(
                  view.state.tr.setMeta(slashPluginKey, { ...state, index }),
                );
                return true;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const command = commands[state.index] ?? commands[0];
                if (command === undefined) return true;
                closeMenu(view);
                applyCommand(editorRef, command, state, options);
                return true;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu(view);
                return true;
              }
              return false;
            },
          },
          view() {
            let menu: HTMLElement | null = null;
            return {
              update(view) {
                const state = readSlashState(view);
                if (state === null || !opensAtLineStart(view, state)) {
                  menu?.remove();
                  menu = null;
                  return;
                }
                menu?.remove();
                try {
                  menu = buildMenu(view, state, editorRef, options);
                  document.body.append(menu);
                } catch (error) {
                  // A menu that cannot be built must never break editing, but it
                  // must not be silent either: ProseMirror swallows plugin-view
                  // exceptions, so report them where diagnostics are collected.
                  menu = null;
                  console.error('[alter-space:slash-menu]', error);
                }
              },
              destroy() {
                menu?.remove();
                menu = null;
              },
            };
          },
        }),
      ];
    },
  });
}




