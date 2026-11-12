import { normalizeBlocks } from './editor-text';

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffBlock {
  kind: DiffKind;
  html: string;
}

function blocksOf(html: string) {
  if (!html.trim()) return [];
  const container = document.createElement('div');
  container.innerHTML = html;
  for (const node of [...container.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim()) {
      node.remove();
    }
  }
  normalizeBlocks(container);
  return [...container.children]
    .filter(
      (element) =>
        (element.textContent ?? '').trim() ||
        element.matches('img,hr,table,[data-divider],[data-todo]'),
    )
    .map((element) => element.outerHTML);
}

function walkDiff(previous: string[], next: string[]) {
  const rows = previous.length;
  const columns = next.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    Array<number>(columns + 1).fill(0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lcs[row][column] =
        previous[row] === next[column]
          ? lcs[row + 1][column + 1] + 1
          : Math.max(lcs[row + 1][column], lcs[row][column + 1]);
    }
  }

  const operations: { kind: DiffKind; html: string }[] = [];
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && previous[row] === next[column]) {
      operations.push({ kind: 'same', html: previous[row] });
      row += 1;
      column += 1;
    } else if (
      column < columns &&
      (row >= rows || lcs[row][column + 1] >= lcs[row + 1][column])
    ) {
      operations.push({ kind: 'added', html: next[column] });
      column += 1;
    } else {
      operations.push({ kind: 'removed', html: previous[row] });
      row += 1;
    }
  }
  return operations;
}

/**
 * Compare two stored document snapshots at block level. Removed blocks keep
 * their original position so the preview reads like the version with inline
 * change marks rather than two separate documents.
 */
export function diffHtml(previousHtml: string, nextHtml: string): DiffBlock[] {
  const operations = walkDiff(blocksOf(previousHtml), blocksOf(nextHtml));
  const result: DiffBlock[] = [];
  let removed: string[] = [];
  let added: string[] = [];

  function flush() {
    for (const html of removed) result.push({ kind: 'removed', html });
    for (const html of added) result.push({ kind: 'added', html });
    removed = [];
    added = [];
  }

  for (const operation of operations) {
    if (operation.kind === 'same') {
      flush();
      result.push(operation);
      continue;
    }
    if (operation.kind === 'removed') removed.push(operation.html);
    else added.push(operation.html);
  }
  flush();
  return result;
}
