/** Collapse the selection to the end of one editable element. */
export function placeCaretAtEnd(element: HTMLElement) {
  const editable = element.closest<HTMLElement>('[contenteditable="true"]');
  editable?.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (!editable) element.focus();
}
