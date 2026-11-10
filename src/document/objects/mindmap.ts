/**
 * Mindmap object payload: schema types, validation and pure tree utilities.
 *
 * A mindmap is a side-table object (`obj_…`) referenced by an `alterMindmap`
 * block; the payload never enters the document AST or the Markdown projection.
 * The shape mirrors the Host `validateObjectPayload('mindmap', …)` contract:
 * `{ root: { id, text, children?: […] } }` with at most 500 nodes and at most
 * 500 characters of text per node.
 *
 * The tree editor (`MindmapEditor`) and the editor surface share these helpers
 * so client validation and the Host contract cannot drift.
 *
 * @module @alter-dsh/space/document/objects/mindmap
 */

/** One mindmap tree node. */
export interface MindmapNode {
  id: string;
  text: string;
  children?: MindmapNode[];
}

/** Object payload of one mindmap. */
export interface MindmapPayload {
  root: MindmapNode;
}

/** Host contract: maximum number of nodes in one mindmap. */
export const MINDMAP_MAX_NODES = 500;

/** Host contract: maximum text length of one node. */
export const MINDMAP_MAX_TEXT_LENGTH = 500;

/** Default root label of a new mindmap. */
export const MINDMAP_DEFAULT_ROOT_TEXT = '中心主题';

/** Default label of a newly added child node. */
export const MINDMAP_DEFAULT_CHILD_TEXT = '新节点';

/** Window event dispatched by the mindmap node view to request the editor. */
export const MINDMAP_EDIT_EVENT = 'alter-mindmap-edit';

/** Detail of {@link MINDMAP_EDIT_EVENT}. */
export interface MindmapEditRequest {
  /** AST block id of the `mindmap` block (missing for unsaved draft blocks). */
  blockId?: string;
  /** Object id stored in the block attrs. */
  objectId: string;
}

/** Result of validating an untrusted object payload. */
export type MindmapValidation =
  | { ok: true; payload: MindmapPayload }
  | { ok: false; error: string };

let nodeSequence = 0;

/** Fresh client-side node id; the Host only requires a unique string. */
function newMindmapNodeId(): string {
  nodeSequence += 1;
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  const unique =
    cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `mm_${unique.replaceAll('-', '')}${nodeSequence}`;
}

/** Create a one-node mindmap payload. */
export function createMindmapPayload(
  text: string = MINDMAP_DEFAULT_ROOT_TEXT,
): MindmapPayload {
  return {
    root: {
      id: newMindmapNodeId(),
      text: text.slice(0, MINDMAP_MAX_TEXT_LENGTH),
    },
  };
}

/** Count all nodes of one tree. */
export function countMindmapNodes(root: MindmapNode): number {
  let count = 0;
  const stack: MindmapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    if (node.children !== undefined) stack.push(...node.children);
  }
  return count;
}

/** Find one node by id (depth-first). */
export function findMindmapNode(
  root: MindmapNode,
  id: string,
): MindmapNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findMindmapNode(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Flatten the tree in display order (parent before children). */
export function flattenMindmap(
  root: MindmapNode,
): Array<{ node: MindmapNode; depth: number }> {
  const rows: Array<{ node: MindmapNode; depth: number }> = [];
  const visit = (node: MindmapNode, depth: number): void => {
    rows.push({ node, depth });
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return rows;
}

/**
 * Validate an untrusted payload against the Host mindmap contract.
 * Returns a normalized copy (only `id`/`text`/`children` survive).
 */
export function validateMindmapPayload(value: unknown): MindmapValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '思维导图数据必须是对象' };
  }
  const root = (value as { root?: unknown }).root;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { ok: false, error: '思维导图数据缺少 root 对象' };
  }
  let count = 0;
  const normalize = (node: unknown, path: string): MindmapNode | string => {
    count += 1;
    if (count > MINDMAP_MAX_NODES) {
      return `思维导图节点数超过 ${MINDMAP_MAX_NODES}`;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return `${path} 不是有效节点`;
    }
    const record = node as Record<string, unknown>;
    const id = record['id'];
    const text = record['text'];
    if (typeof id !== 'string' || id.trim() === '') {
      return `${path} 缺少节点 id`;
    }
    if (typeof text !== 'string') {
      return `${path} 缺少节点文本`;
    }
    if (text.length > MINDMAP_MAX_TEXT_LENGTH) {
      return `${path} 文本超过 ${MINDMAP_MAX_TEXT_LENGTH} 字`;
    }
    const childrenRaw = record['children'];
    const result: MindmapNode = { id, text };
    if (childrenRaw !== undefined) {
      if (!Array.isArray(childrenRaw)) return `${path} 的 children 必须是数组`;
      const children: MindmapNode[] = [];
      for (const [index, child] of childrenRaw.entries()) {
        const normalized = normalize(child, `${path}.children[${index}]`);
        if (typeof normalized === 'string') return normalized;
        children.push(normalized);
      }
      if (children.length > 0) result.children = children;
    }
    return result;
  };
  const normalized = normalize(root, 'root');
  if (typeof normalized === 'string') return { ok: false, error: normalized };
  return { ok: true, payload: { root: normalized } };
}

/** Apply an updater to the node with `id`, rebuilding the path immutably. */
function updateNode(
  root: MindmapNode,
  id: string,
  update: (node: MindmapNode) => MindmapNode,
): MindmapNode {
  if (root.id === id) return update(root);
  const children = root.children;
  if (children === undefined) return root;
  let changed = false;
  const nextChildren = children.map((child) => {
    const next = updateNode(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  if (!changed) return root;
  return { ...root, children: nextChildren };
}

/** Rename one node; text is clipped to the Host limit. */
export function renameMindmapNode(
  payload: MindmapPayload,
  id: string,
  text: string,
): MindmapPayload {
  const nextText = text.slice(0, MINDMAP_MAX_TEXT_LENGTH);
  return {
    root: updateNode(payload.root, id, (node) => ({ ...node, text: nextText })),
  };
}

/** Append one child under `parentId`; `undefined` when the node budget is full. */
export function addMindmapChild(
  payload: MindmapPayload,
  parentId: string,
  text: string = MINDMAP_DEFAULT_CHILD_TEXT,
): MindmapPayload | undefined {
  if (countMindmapNodes(payload.root) >= MINDMAP_MAX_NODES) return undefined;
  const parent = findMindmapNode(payload.root, parentId);
  if (parent === undefined) return undefined;
  const child: MindmapNode = {
    id: newMindmapNodeId(),
    text: text.slice(0, MINDMAP_MAX_TEXT_LENGTH),
  };
  return {
    root: updateNode(payload.root, parentId, (node) => ({
      ...node,
      children: [...(node.children ?? []), child],
    })),
  };
}

/** Remove one node (and its subtree); the root cannot be deleted. */
export function deleteMindmapNode(
  payload: MindmapPayload,
  id: string,
): MindmapPayload | undefined {
  if (payload.root.id === id) return undefined;
  const removeFrom = (node: MindmapNode): MindmapNode | undefined => {
    const children = node.children;
    if (children === undefined) return undefined;
    let changed = false;
    const nextChildren: MindmapNode[] = [];
    for (const child of children) {
      if (child.id === id) {
        changed = true;
        continue;
      }
      const next = removeFrom(child);
      if (next === undefined) nextChildren.push(child);
      else {
        changed = true;
        nextChildren.push(next);
      }
    }
    if (!changed) return undefined;
    const next: MindmapNode = { ...node };
    if (nextChildren.length > 0) next.children = nextChildren;
    else delete next.children;
    return next;
  };
  const nextRoot = removeFrom(payload.root);
  return nextRoot === undefined ? undefined : { root: nextRoot };
}

/** Deep clone of a payload (editor drafts must never mutate the loaded object). */
export function cloneMindmapPayload(payload: MindmapPayload): MindmapPayload {
  const cloneNode = (node: MindmapNode): MindmapNode => ({
    id: node.id,
    text: node.text,
    ...(node.children === undefined
      ? {}
      : { children: node.children.map(cloneNode) }),
  });
  return { root: cloneNode(payload.root) };
}
