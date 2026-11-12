/**
 * Keyboard and markdown-shortcut parity with the frozen editor.
 *
 * The frozen editor implements shortcuts itself; both families must survive the
 * kernel swap or users lose muscle memory:
 *
 * - **inline marks**: `Mod-U` (underline) is not a browser default, so the frozen
 *   editor implements it by hand; bold/italic/strike/code come from the
 *   browser/ProseMirror defaults;
 * - **line conversions typed at the start of a line**, applied on the following
 *   space: `#`/`##`/`###`, `-`/`*`, `[]`/`[ ]`, `>`/`》`, ``` and `N.` (ordered
 *   list starting at N).
 *
 * ProseMirror's stock input rules already cover `#`, `-`, `*`, `>` and `N.`; the
 * rules added here close the gaps the frozen editor supported explicitly: the
 * full-width `》` and both spellings of the task-list marker.
 *
 * @module @alter-dsh/space/document/editors/tiptap/keyboard
 */
import { Extension, wrappingInputRule, type AnyExtension } from '@tiptap/core';

/**
 * The keyboard extension.
 *
 * `Mod-U` is registered as a Tiptap shortcut so it fires before the browser's
 * own bindings (which do not underline) and works for the manifest's marks.
 * Line rules use Tiptap's `addInputRules` hook so they run through the same
 * plugin pipeline as the stock markdown rules.
 */
export function createKeyboardExtension(): AnyExtension {
  return Extension.create({
    name: 'alterSpaceKeyboard',
    addInputRules() {
      const schema = this.editor.schema;
      return [
        // Full-width quote marker: `》` + space turns the line into a blockquote.
        wrappingInputRule({
          find: /^》\s$/,
          type: schema.nodes['blockquote']!,
        }),
        // Task-list marker: `[]` or `[ ]` followed by a space.
        wrappingInputRule({
          find: /^\[ ?\]\s$/,
          type: schema.nodes['taskList']!,
        }),
      ];
    },
    addKeyboardShortcuts() {
      return {
        'Mod-u': () => this.editor.chain().focus().toggleMark('underline').run(),
      };
    },
  });
}