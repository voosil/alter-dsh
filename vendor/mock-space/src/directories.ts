import type { DirectoryEntry, DirectoryListing } from './types';

export const HOME_PATH = '~';

interface MockDirectory {
  name: string;
  children?: MockDirectory[];
}

const home: MockDirectory = {
  name: '主目录',
  children: [
    {
      name: 'Documents',
      children: [
        {
          name: 'Alter',
          children: [
            { name: '认知与判断' },
            { name: '产品与行动' },
            { name: '阅读笔记' },
          ],
        },
        { name: '工作' },
        { name: '归档' },
      ],
    },
    {
      name: 'Notes',
      children: [{ name: '判断' }, { name: '灵感' }],
    },
    {
      name: 'Projects',
      children: [{ name: 'Alter' }, { name: 'Side Projects' }],
    },
    {
      name: 'Desktop',
      children: [{ name: '阅读材料' }],
    },
    { name: 'Downloads' },
  ],
};

const collator = new Intl.Collator('zh-CN');

function compareNames(left: string, right: string) {
  const leftLatin = /^[A-Za-z]/.test(left);
  const rightLatin = /^[A-Za-z]/.test(right);
  if (leftLatin !== rightLatin) return leftLatin ? -1 : 1;
  return collator.compare(left, right);
}

function normalize(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === HOME_PATH || trimmed === `${HOME_PATH}/`)
    return HOME_PATH;
  return trimmed.replace(/\/+/g, '/').replace(/\/+$/, '');
}

function findDirectory(path: string): MockDirectory | undefined {
  if (path === HOME_PATH) return home;
  if (!path.startsWith(`${HOME_PATH}/`)) return undefined;
  const segments = path
    .slice(HOME_PATH.length + 1)
    .split('/')
    .filter(Boolean);
  let current: MockDirectory | undefined = home;
  for (const segment of segments) {
    current = current?.children?.find((child) => child.name === segment);
    if (!current) return undefined;
  }
  return current;
}

function childPath(parent: string, name: string) {
  return `${parent}/${name}`;
}

export function listDirectories(path: string = HOME_PATH): DirectoryListing {
  const normalized = normalize(path);
  const directory = findDirectory(normalized);
  if (!directory) throw new Error('目录不存在');
  const entries: DirectoryEntry[] = (directory.children ?? [])
    .slice()
    .sort((left, right) => compareNames(left.name, right.name))
    .map((child) => ({
      path: childPath(normalized, child.name),
      name: child.name,
    }));
  return { path: normalized, entries };
}
