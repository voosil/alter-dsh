export type SpaceViewName =
  | 'doc'
  | 'thoughts'
  | 'overview'
  | 'plugin'
  | 'config'
  | 'trash'
  | 'archive';

export interface SpaceRoute {
  spaceId?: string;
  view: SpaceViewName;
  id?: string;
  raw: string;
}

const views = new Set<SpaceViewName>([
  'doc',
  'thoughts',
  'overview',
  'plugin',
  'config',
  'trash',
  'archive',
]);

export function isSpaceRoutePath(path: string) {
  const module = path.replace(/^#\/?/, '').split('/')[0];
  return !module || module === 'space';
}

export function parseSpaceRoute(path: string): SpaceRoute {
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  const spaceId = parts[1];
  const candidate = parts[2] as SpaceViewName | undefined;
  const view =
    candidate && views.has(candidate)
      ? candidate
      : spaceId
        ? 'overview'
        : 'doc';
  return {
    spaceId,
    view,
    id: parts[3],
    raw: path,
  };
}

export function spacePath(spaceId: string) {
  return `#/space/${spaceId}`;
}

export function docPath(spaceId: string, docId: string) {
  return `#/space/${spaceId}/doc/${docId}`;
}

export function thoughtsPath(spaceId: string, thoughtId?: string) {
  return `#/space/${spaceId}/thoughts${thoughtId ? `/${thoughtId}` : ''}`;
}

export function overviewPath(spaceId: string) {
  return `#/space/${spaceId}/overview`;
}

export function configPath(spaceId: string) {
  return `#/space/${spaceId}/config`;
}

export function trashPath(spaceId: string) {
  return `#/space/${spaceId}/trash`;
}

export function archivePath(
  spaceId: string,
  tab: 'docs' | 'thoughts' = 'docs',
) {
  return `#/space/${spaceId}/archive${tab === 'thoughts' ? '/thoughts' : ''}`;
}
