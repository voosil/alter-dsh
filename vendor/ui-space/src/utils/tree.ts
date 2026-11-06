import type { SpaceNode } from '@alter/protocol';

export function bySiblingOrder(a: SpaceNode, b: SpaceNode) {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt);
}

export function childrenMap(nodes: SpaceNode[]) {
  const map = new Map<string | null, SpaceNode[]>();
  for (const node of nodes) {
    const list = map.get(node.parentId) ?? [];
    list.push(node);
    map.set(node.parentId, list);
  }
  for (const list of map.values()) list.sort(bySiblingOrder);
  return map;
}

export interface FlatNode {
  node: SpaceNode;
  depth: number;
}

export function flattenTree(
  nodes: SpaceNode[],
  expanded: Set<string>,
): FlatNode[] {
  const map = childrenMap(nodes);
  const result: FlatNode[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const node of map.get(parentId) ?? []) {
      result.push({ node, depth });
      if (expanded.has(node.id)) walk(node.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

export function ancestorsOf(nodes: SpaceNode[], id: string) {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const result: SpaceNode[] = [];
  let current = map.get(id)?.parentId ?? null;
  while (current) {
    const parent = map.get(current);
    if (!parent) break;
    result.unshift(parent);
    current = parent.parentId;
  }
  return result;
}

export function descendantIds(nodes: SpaceNode[], id: string) {
  const result = new Set<string>();
  const queue = nodes.filter((node) => node.parentId === id);
  while (queue.length) {
    const next = queue.shift();
    if (!next) break;
    result.add(next.id);
    queue.push(...nodes.filter((node) => node.parentId === next.id));
  }
  return result;
}

export function defaultDocId(nodes: SpaceNode[]) {
  const docs = nodes
    .filter((node) => node.kind === 'note' && !node.archived)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return docs[0]?.id;
}

export function pathLabel(nodes: SpaceNode[], id: string) {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const parts: string[] = [];
  let current = map.get(id)?.parentId ?? null;
  while (current) {
    const node = map.get(current);
    if (!node) break;
    parts.unshift(node.title);
    current = node.parentId;
  }
  return parts.join(' / ');
}

export function displayTitle(title: string) {
  return title.trim() || '无标题';
}
