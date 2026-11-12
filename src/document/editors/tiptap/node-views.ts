/**
 * ProseMirror node views for kernel blocks whose DOM must survive updates.
 *
 * Only the todo row needs one: toggling `checked` must update the existing DOM
 * (the box's aria state and the row's `data-checked` the frozen stylesheet keys
 * off) instead of recreating the row. Recreating it would drop focus from the
 * checkbox, which breaks the frozen "click the box / press Space twice" loop.
 *
 * The row DOM is the legacy shape: `div[data-todo]` holding a non-editable
 * `span[data-todo-box]` and a `span[data-todo-text]` content hole. The stylesheet
 * (`Editor.module.css`) draws the checkbox and the checked strikethrough from
 * those attributes alone.
 *
 * @module @alter-dsh/space/document/editors/tiptap/node-views
 */
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { NodeView } from '@tiptap/pm/view';

/** Attributes shared by the serialized (`renderHTML`) and live todo row DOM. */
export function todoRowAttributes(
  attrs: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const checked = attrs['checked'] === true;
  const id = attrs['id'];
  const out: Record<string, string> = {
    'data-todo': '',
    'data-checked': String(checked),
  };
  if (typeof id === 'string' && id !== '') out['data-block-id'] = id;
  return out;
}

/** Attributes of the non-editable checkbox span (frozen a11y contract). */
export function todoBoxAttributes(checked: boolean): Record<string, string> {
  return {
    'data-todo-box': '',
    contenteditable: 'false',
    role: 'checkbox',
    'aria-checked': String(checked),
    'aria-label': '待办事项',
    tabindex: '0',
  };
}

/** Attributes of the editable text span. */
export const TODO_TEXT_ATTRIBUTES: Readonly<Record<string, string>> = {
  'data-todo-text': '',
};

/** Write current `checked`/id state onto one live todo row. */
function syncRow(
  dom: HTMLElement,
  box: HTMLElement,
  node: PmNode,
): void {
  const checked = node.attrs['checked'] === true;
  dom.setAttribute('data-checked', String(checked));
  box.setAttribute('aria-checked', String(checked));
  const id = node.attrs['id'];
  if (typeof id === 'string' && id !== '') {
    dom.setAttribute('data-block-id', id);
  } else {
    dom.removeAttribute('data-block-id');
  }
}

/**
 * Node view for one todo row.
 *
 * The box toggles `checked` through the normal dispatch path (so the shell's
 * `onChange` save fires), and both the box and its Space/Enter handler stop the
 * event from reaching ProseMirror: the caret must stay where it was, as in the
 * frozen editor.
 */
export function createTaskItemView(props: NodeViewRendererProps): NodeView {
  const { node, view, getPos } = props;

  const dom = document.createElement('div');
  dom.setAttribute('data-todo', '');
  const box = document.createElement('span');
  for (const [name, value] of Object.entries(
    todoBoxAttributes(node.attrs['checked'] === true),
  )) {
    box.setAttribute(name, value);
  }
  const text = document.createElement('span');
  text.setAttribute('data-todo-text', '');
  dom.append(box, text);

  let current = node;
  syncRow(dom, box, node);

  const toggle = (): void => {
    const position = getPos();
    if (position === undefined) return;
    const nextChecked = current.attrs['checked'] !== true;
    view.dispatch(
      view.state.tr.setNodeMarkup(position, undefined, {
        ...current.attrs,
        checked: nextChecked,
      }),
    );
  };

  box.addEventListener('mousedown', (event) => {
    // Keep the caret: activating the box is not a text-selection gesture.
    event.preventDefault();
    box.focus();
  });
  box.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });
  box.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });

  return {
    dom,
    contentDOM: text,
    update(nextNode: PmNode): boolean {
      if (nextNode.type !== current.type) return false;
      current = nextNode;
      syncRow(dom, box, nextNode);
      return true;
    },
    // Only the text span belongs to the document; attribute writes on the box
    // and row are the node view's business.
    ignoreMutation(mutation): boolean {
      return !text.contains(mutation.target);
    },
    // Events on the box are handled here, never by ProseMirror's mouse/key maps.
    stopEvent(event): boolean {
      return box.contains(event.target as globalThis.Node | null);
    },
  };
}