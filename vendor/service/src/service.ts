/** Real Space content business service, ported from the design-stage mock. */
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  Agent,
  AgentPermission,
  Comment,
  CreateAgentInput,
  DirectoryEntry,
  DocVersion,
  Milestone,
  NewSpaceInput,
  NodeKind,
  NodePatch,
  SearchResult,
  Space,
  SpaceActivityEvent,
  SpaceNode,
  SpaceOverview,
  SpacePatch,
  SpaceService,
  SpaceTask,
  Thought,
} from '@alter/protocol';
import type {
  SpaceContentServiceOptions,
  SpaceStoreData,
} from './contracts.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const HOME_PATH = '~';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

/** Known collaborator capability grants, in a stable display order. */
const AGENT_PERMISSIONS: AgentPermission[] = [
  'read',
  'edit',
  'comment',
  'manage',
];

/** Drop unknown permission keys and duplicate grants from a creation payload. */
function normalizeAgentPermissions(input: unknown): AgentPermission[] {
  if (!Array.isArray(input)) return [];
  return AGENT_PERMISSIONS.filter((permission) => input.includes(permission));
}

function toIso(date: Date) {
  return date.toISOString();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u200b/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function excerptAround(text: string, query: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const index = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return normalized.slice(0, 72);
  const start = Math.max(0, index - 28);
  const end = Math.min(normalized.length, index + query.length + 44);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${
    end < normalized.length ? '…' : ''
  }`;
}

/** 概览按本地时区的自然日聚合；调用方只会传入已校验为有限时间的事件。 */
function localDayKey(value: string) {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function excerpt(value: string, max = 48) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const directoryCollator = new Intl.Collator('zh-CN');

function compareDirectoryNames(left: string, right: string) {
  const leftLatin = /^[A-Za-z]/.test(left);
  const rightLatin = /^[A-Za-z]/.test(right);
  if (leftLatin !== rightLatin) return leftLatin ? -1 : 1;
  return directoryCollator.compare(left, right);
}

/** 界面使用 `~` 表示主目录；其它写法按绝对路径处理，相对路径不可读取。 */
function normalizeDirectoryPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === HOME_PATH || trimmed === `${HOME_PATH}/`)
    return HOME_PATH;
  const collapsed = trimmed.replace(/\/+/g, '/');
  if (collapsed === '/') return collapsed;
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

function resolveDirectoryPath(normalized: string) {
  if (normalized === HOME_PATH) return homedir();
  if (normalized.startsWith(`${HOME_PATH}/`))
    return join(homedir(), normalized.slice(HOME_PATH.length + 1));
  return isAbsolute(normalized) ? normalized : undefined;
}

/**
 * Content authority over the persistent store. Reads clone the value out of the
 * store; every change runs inside {@link SpaceStore.update} so it is persisted
 * serially and rolled back uniformly on failure.
 */
export function createContentService(
  options: SpaceContentServiceOptions,
): SpaceService {
  const { store, hub } = options;
  const now = options.now;

  function currentSpace(data: SpaceStoreData, id: string) {
    const space = data.spaces.find((item) => item.id === id);
    if (!space) throw new Error('空间不存在');
    return space;
  }

  function currentNode(data: SpaceStoreData, id: string) {
    const node = data.nodes.find((item) => item.id === id);
    if (!node) throw new Error('文档不存在');
    return node;
  }

  function activityOf(node: SpaceNode, timestamp: Date) {
    const elapsed = Math.max(
      0,
      timestamp.getTime() - Date.parse(node.activityAt),
    );
    return clamp(Math.round(node.activity - (elapsed / DAY) * 8), 0, 100);
  }

  function decorate(node: SpaceNode, timestamp = now()): SpaceNode {
    return { ...clone(node), activity: activityOf(node, timestamp) };
  }

  function needsArchiving(node: SpaceNode, timestamp: Date) {
    return (
      node.kind === 'note' &&
      !node.deletedAt &&
      !node.archived &&
      !node.pinned &&
      activityOf(node, timestamp) <= 0
    );
  }

  async function sweepArchives() {
    const timestamp = now();
    if (!store.read().nodes.some((node) => needsArchiving(node, timestamp)))
      return;
    await store.update((data) => {
      for (const node of data.nodes) {
        if (!needsArchiving(node, timestamp)) continue;
        node.archived = true;
        node.archivedBy = 'agent';
        node.archivedAt = toIso(timestamp);
        node.activity = 0;
        node.activityAt = toIso(timestamp);
      }
    });
  }

  function descendantsOf(data: SpaceStoreData, id: string) {
    const result: SpaceNode[] = [];
    const queue = data.nodes.filter((node) => node.parentId === id);
    for (let index = 0; index < queue.length; index += 1) {
      const next = queue[index];
      result.push(next);
      queue.push(...data.nodes.filter((node) => node.parentId === next.id));
    }
    return result;
  }

  function recordVersion(
    data: SpaceStoreData,
    node: SpaceNode,
    timestamp: Date,
  ) {
    const versions = data.versions
      .filter((version) => version.docId === node.id)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const latest = versions[0];
    if (latest && timestamp.getTime() - Date.parse(latest.at) < 5 * 60_000)
      return;
    data.versions.push({
      id: createId('ver'),
      docId: node.id,
      title: node.title,
      content: node.content,
      author: 'me',
      at: toIso(timestamp),
    });
  }

  return {
    hub,

    async listSpaces() {
      return clone(store.read().spaces)
        .filter((space) => !space.archivedAt)
        .sort(
          (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt),
        );
    },

    async getSpace(id) {
      const space = store.read().spaces.find((item) => item.id === id);
      return space ? clone(space) : undefined;
    },

    async createSpace(input: NewSpaceInput) {
      const name = input.name.trim();
      if (!name) throw new Error('空间名称不能为空');
      return store.update((data) => {
        const space: Space = {
          id: createId('sp'),
          name,
          goal: input.goal?.trim() ?? '',
          directories: input.directories ?? [],
          collaboratorIds: input.collaboratorIds ?? [],
          icon: input.icon ?? 'layers',
          color: input.color ?? '#4c4e53',
          isDefault: false,
          order:
            data.spaces.reduce((max, item) => Math.max(max, item.order), 0) + 1,
          createdAt: toIso(now()),
          archivedAt: null,
        };
        data.spaces.push(space);
        return clone(space);
      });
    },

    async updateSpace(id, patch: SpacePatch) {
      return store.update((data) => {
        const space = currentSpace(data, id);
        if (patch.name !== undefined) {
          const name = patch.name.trim();
          if (!name) throw new Error('空间名称不能为空');
          space.name = name;
        }
        if (patch.goal !== undefined) space.goal = patch.goal.trim();
        if (patch.directories !== undefined)
          space.directories = [...new Set(patch.directories)];
        if (patch.collaboratorIds !== undefined)
          space.collaboratorIds = [...new Set(patch.collaboratorIds)];
        if (patch.icon !== undefined) space.icon = patch.icon;
        if (patch.color !== undefined) space.color = patch.color;
        return clone(space);
      });
    },

    async archiveSpace(id) {
      return store.update((data) => {
        const space = currentSpace(data, id);
        if (space.isDefault) throw new Error('默认空间不能归档');
        if (!space.archivedAt) space.archivedAt = toIso(now());
        return clone(space);
      });
    },

    async unarchiveSpace(id) {
      return store.update((data) => {
        const space = currentSpace(data, id);
        if (space.archivedAt) {
          space.archivedAt = null;
          space.order =
            data.spaces.reduce((max, item) => Math.max(max, item.order), 0) + 1;
        }
        return clone(space);
      });
    },

    async listArchivedSpaces() {
      return clone(store.read().spaces)
        .filter((space) => space.archivedAt)
        .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));
    },

    async deleteSpace(id) {
      return store.update((data) => {
        const space = currentSpace(data, id);
        if (space.isDefault) throw new Error('默认空间不能删除');
        const docIds = new Set(
          data.nodes
            .filter((node) => node.spaceId === id)
            .map((node) => node.id),
        );
        hub.remove(id);
        data.spaces = data.spaces.filter((item) => item.id !== id);
        data.nodes = data.nodes.filter((node) => node.spaceId !== id);
        data.thoughts = data.thoughts.filter(
          (thought) => thought.spaceId !== id,
        );
        data.comments = data.comments.filter(
          (comment) => !docIds.has(comment.docId),
        );
        data.versions = data.versions.filter(
          (version) => !docIds.has(version.docId),
        );
        data.tasks = data.tasks.filter((task) => task.spaceId !== id);
        data.events = data.events.filter((event) => event.spaceId !== id);
        data.milestones = data.milestones.filter((item) => item.spaceId !== id);
      });
    },

    async reorderSpaces(ids) {
      return store.update((data) => {
        ids.forEach((id, index) => {
          const space = data.spaces.find((item) => item.id === id);
          if (space) space.order = index;
        });
        return clone(data.spaces).sort((a, b) => a.order - b.order);
      });
    },

    async listNodes(spaceId) {
      await sweepArchives();
      const timestamp = now();
      return store
        .read()
        .nodes.filter((node) => node.spaceId === spaceId && !node.deletedAt)
        .map((node) => decorate(node, timestamp));
    },

    async getNode(id) {
      await sweepArchives();
      const node = store
        .read()
        .nodes.find((item) => item.id === id && !item.deletedAt);
      return node ? decorate(node) : undefined;
    },

    async createNode(input: {
      spaceId: string;
      parentId?: string | null;
      kind: NodeKind;
      title?: string;
    }) {
      return store.update((data) => {
        currentSpace(data, input.spaceId);
        const parentId = input.parentId ?? null;
        if (input.kind === 'folder' && parentId)
          throw new Error('文件夹只能创建在根目录');
        if (parentId) {
          const parent = currentNode(data, parentId);
          if (parent.spaceId !== input.spaceId)
            throw new Error('上级目录不属于当前空间');
        }
        const timestamp = toIso(now());
        const siblings = data.nodes.filter(
          (node) =>
            node.spaceId === input.spaceId &&
            node.parentId === parentId &&
            !node.deletedAt,
        );
        const node: SpaceNode = {
          id: createId('doc'),
          spaceId: input.spaceId,
          kind: input.kind,
          title:
            input.title?.trim() ??
            (input.kind === 'folder' ? '新建文件夹' : ''),
          parentId,
          creator: 'me',
          pinned: false,
          archived: false,
          archivedBy: null,
          archivedAt: null,
          deletedAt: null,
          deletedRoot: false,
          originalParentId: null,
          unread: false,
          content: '',
          activity: 100,
          activityAt: timestamp,
          lastOpenCreditAt: null,
          lastEditCreditAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          order:
            siblings.reduce((min, item) => Math.min(min, item.order), 0) - 1,
        };
        data.nodes.push(node);
        return clone(node);
      });
    },

    async saveNode(id, patch: NodePatch) {
      return store.update((data) => {
        const node = currentNode(data, id);
        const timestamp = now();
        let changed = false;
        let contentChanged = false;
        if (patch.title !== undefined && patch.title !== node.title) {
          node.title = patch.title.trim();
          changed = true;
        }
        if (patch.content !== undefined && patch.content !== node.content) {
          contentChanged = true;
          node.content = patch.content;
          const activity = activityOf(node, timestamp);
          const canCredit =
            !node.lastEditCreditAt ||
            timestamp.getTime() - Date.parse(node.lastEditCreditAt) > HOUR;
          node.activity = clamp(activity + (canCredit ? 20 : 0), 0, 100);
          node.activityAt = toIso(timestamp);
          if (canCredit) node.lastEditCreditAt = toIso(timestamp);
          changed = true;
        }
        if (!changed) return decorate(node, timestamp);
        node.updatedAt = toIso(timestamp);
        if (contentChanged) recordVersion(data, node, timestamp);
        return decorate(node, timestamp);
      });
    },

    async moveNode(id, target) {
      return store.update((data) => {
        const node = currentNode(data, id);
        currentSpace(data, target.spaceId);
        if (node.kind === 'folder' && target.parentId)
          throw new Error('文件夹只能位于根目录');
        if (target.parentId) {
          const parent = currentNode(data, target.parentId);
          if (parent.spaceId !== target.spaceId)
            throw new Error('目标位置不属于目标空间');
          if (parent.id === id) throw new Error('不能移动到自身');
          if (descendantsOf(data, id).some((item) => item.id === parent.id))
            throw new Error('不能移动到自己的子层级');
        }
        const subtree = [node, ...descendantsOf(data, id)];
        for (const item of subtree) item.spaceId = target.spaceId;
        node.parentId = target.parentId;
        if (target.order !== undefined) node.order = target.order;
        node.updatedAt = toIso(now());
        return clone(node);
      });
    },

    async setPinned(id, pinned) {
      return store.update((data) => {
        const node = currentNode(data, id);
        node.pinned = pinned;
        return decorate(node);
      });
    },

    async setArchived(id, archived) {
      return store.update((data) => {
        const node = currentNode(data, id);
        if (archived) {
          node.archived = true;
          node.archivedBy = 'user';
          node.archivedAt = toIso(now());
          node.pinned = false;
        } else {
          const timestamp = now();
          node.archived = false;
          node.archivedBy = null;
          node.archivedAt = null;
          node.activity = 80;
          node.activityAt = toIso(timestamp);
        }
        return decorate(node);
      });
    },

    async deleteNode(id) {
      return store.update((data) => {
        const node = currentNode(data, id);
        const timestamp = toIso(now());
        node.deletedAt = timestamp;
        node.deletedRoot = true;
        node.originalParentId = node.parentId;
        for (const item of descendantsOf(data, id)) {
          item.deletedAt = timestamp;
          item.deletedRoot = false;
        }
      });
    },

    async restoreNode(id) {
      return store.update((data) => {
        const node = currentNode(data, id);
        if (!node.deletedAt) return decorate(node);
        const deletedAt = node.deletedAt;
        const originalParent = node.originalParentId;
        node.deletedAt = null;
        node.deletedRoot = false;
        node.originalParentId = null;
        if (originalParent) {
          const parent = data.nodes.find((item) => item.id === originalParent);
          node.parentId = parent && !parent.deletedAt ? parent.id : null;
        }
        for (const item of data.nodes) {
          if (item.deletedAt === deletedAt && item.id !== node.id) {
            item.deletedAt = null;
            item.deletedRoot = false;
          }
        }
        return clone(node);
      });
    },

    async recordOpen(id) {
      return store.update((data) => {
        const node = currentNode(data, id);
        const timestamp = now();
        node.unread = false;
        const activity = activityOf(node, timestamp);
        const canCredit =
          !node.lastOpenCreditAt ||
          timestamp.getTime() - Date.parse(node.lastOpenCreditAt) > HOUR;
        node.activity = clamp(activity + (canCredit ? 5 : 0), 0, 100);
        node.activityAt = toIso(timestamp);
        if (canCredit) node.lastOpenCreditAt = toIso(timestamp);
        return decorate(node, timestamp);
      });
    },

    async listComments(docId) {
      return clone(
        store
          .read()
          .comments.filter((comment) => comment.docId === docId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },

    async addComment(input: {
      docId: string;
      body: string;
      quote?: string | null;
    }) {
      return store.update((data) => {
        const node = currentNode(data, input.docId);
        const body = input.body.trim();
        if (!body) throw new Error('评论内容不能为空');
        const comment: Comment = {
          id: createId('cm'),
          docId: node.id,
          author: 'me',
          body,
          quote: input.quote?.trim() || null,
          status: 'open',
          createdAt: toIso(now()),
          resolvedAt: null,
          editedAt: null,
          supplements: [],
        };
        data.comments.push(comment);
        return clone(comment);
      });
    },

    async updateComment(id, patch) {
      return store.update((data) => {
        const comment = data.comments.find((item) => item.id === id);
        if (!comment) throw new Error('评论不存在');
        if (patch.body !== undefined) {
          const body = patch.body.trim();
          if (!body) throw new Error('评论内容不能为空');
          if (comment.body !== body) {
            comment.body = body;
            comment.editedAt = toIso(now());
          }
        }
        if (patch.quote !== undefined) {
          comment.quote = patch.quote;
        }
        return clone(comment);
      });
    },

    async addCommentSupplement(id, body) {
      return store.update((data) => {
        const comment = data.comments.find((item) => item.id === id);
        if (!comment) throw new Error('评论不存在');
        const content = body.trim();
        if (!content) throw new Error('补充内容不能为空');
        comment.supplements.push({
          id: createId('cs'),
          author: 'me',
          body: content,
          createdAt: toIso(now()),
        });
        return clone(comment);
      });
    },

    async deleteComment(id) {
      return store.update((data) => {
        const index = data.comments.findIndex((item) => item.id === id);
        if (index < 0) throw new Error('评论不存在');
        data.comments.splice(index, 1);
      });
    },

    async resolveComment(id) {
      return store.update((data) => {
        const comment = data.comments.find((item) => item.id === id);
        if (!comment) throw new Error('评论不存在');
        comment.status = 'resolved';
        comment.resolvedAt = toIso(now());
        return clone(comment);
      });
    },

    async listVersions(docId) {
      return clone(
        store
          .read()
          .versions.filter((version) => version.docId === docId)
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      );
    },

    async restoreVersion(docId, versionId) {
      return store.update((data) => {
        const node = currentNode(data, docId);
        const version = data.versions.find((item) => item.id === versionId);
        if (!version || version.docId !== docId) throw new Error('版本不存在');
        const timestamp = now();
        recordVersion(data, node, timestamp);
        node.content = version.content;
        node.title = version.title;
        node.updatedAt = toIso(timestamp);
        node.activity = clamp(activityOf(node, timestamp) + 20, 0, 100);
        node.activityAt = toIso(timestamp);
        node.lastEditCreditAt = toIso(timestamp);
        return decorate(node, timestamp);
      });
    },

    async listThoughts(spaceId, listOptions) {
      return clone(
        store
          .read()
          .thoughts.filter(
            (thought) =>
              thought.spaceId === spaceId &&
              !thought.deletedAt &&
              !thought.convertedDocId &&
              (listOptions?.includeArchived || !thought.archived),
          )
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      );
    },

    async createThought(input) {
      return store.update((data) => {
        currentSpace(data, input.spaceId);
        const content = input.content.trim();
        if (!content) throw new Error('随想内容不能为空');
        const timestamp = toIso(now());
        const thought: Thought = {
          id: createId('th'),
          spaceId: input.spaceId,
          content,
          createdAt: timestamp,
          updatedAt: timestamp,
          archived: false,
          archivedAt: null,
          deletedAt: null,
          convertedDocId: null,
        };
        data.thoughts.push(thought);
        return clone(thought);
      });
    },

    async updateThought(id, content) {
      return store.update((data) => {
        const thought = data.thoughts.find((item) => item.id === id);
        if (!thought) throw new Error('随想不存在');
        const trimmed = content.trim();
        if (!trimmed) throw new Error('随想内容不能为空');
        thought.content = trimmed;
        thought.updatedAt = toIso(now());
        return clone(thought);
      });
    },

    async setThoughtArchived(id, archived) {
      return store.update((data) => {
        const thought = data.thoughts.find((item) => item.id === id);
        if (!thought) throw new Error('随想不存在');
        thought.archived = archived;
        thought.archivedAt = archived ? toIso(now()) : null;
        return clone(thought);
      });
    },

    async deleteThought(id) {
      return store.update((data) => {
        const thought = data.thoughts.find((item) => item.id === id);
        if (!thought) throw new Error('随想不存在');
        thought.deletedAt = toIso(now());
      });
    },

    async restoreThought(id) {
      return store.update((data) => {
        const thought = data.thoughts.find((item) => item.id === id);
        if (!thought) throw new Error('随想不存在');
        thought.deletedAt = null;
        return clone(thought);
      });
    },

    async moveThought(id, spaceId) {
      return store.update((data) => {
        const thought = data.thoughts.find((item) => item.id === id);
        if (!thought) throw new Error('随想不存在');
        currentSpace(data, spaceId);
        thought.spaceId = spaceId;
        return clone(thought);
      });
    },

    async convertThought(id) {
      return store.update((data) => {
        const thought = data.thoughts.find((item) => item.id === id);
        if (!thought) throw new Error('随想不存在');
        if (thought.convertedDocId) throw new Error('这条随想已经转为文档');
        const timestamp = toIso(now());
        const node: SpaceNode = {
          id: createId('doc'),
          spaceId: thought.spaceId,
          kind: 'note',
          title: '',
          parentId: null,
          creator: 'me',
          pinned: false,
          archived: false,
          archivedBy: null,
          archivedAt: null,
          deletedAt: null,
          deletedRoot: false,
          originalParentId: null,
          unread: false,
          content: thought.content,
          activity: 100,
          activityAt: timestamp,
          lastOpenCreditAt: null,
          lastEditCreditAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          order:
            data.nodes
              .filter(
                (item) =>
                  item.spaceId === thought.spaceId &&
                  item.parentId === null &&
                  !item.deletedAt,
              )
              .reduce((min, item) => Math.min(min, item.order), 0) - 1,
        };
        data.nodes.push(node);
        thought.convertedDocId = node.id;
        return { thought: clone(thought), node: clone(node) };
      });
    },

    async listDeleted(spaceId) {
      return {
        nodes: clone(
          store
            .read()
            .nodes.filter(
              (node) => node.spaceId === spaceId && node.deletedRoot,
            )
            .sort(
              (a, b) => Date.parse(b.deletedAt!) - Date.parse(a.deletedAt!),
            ),
        ),
        thoughts: clone(
          store
            .read()
            .thoughts.filter(
              (thought) =>
                thought.spaceId === spaceId && Boolean(thought.deletedAt),
            )
            .sort(
              (a, b) => Date.parse(b.deletedAt!) - Date.parse(a.deletedAt!),
            ),
        ),
      };
    },

    async emptyTrash(spaceId) {
      return store.update((data) => {
        currentSpace(data, spaceId);
        const docIds = new Set(
          data.nodes
            .filter((node) => node.spaceId === spaceId && node.deletedAt)
            .map((node) => node.id),
        );
        data.nodes = data.nodes.filter(
          (node) => !(node.spaceId === spaceId && node.deletedAt),
        );
        data.thoughts = data.thoughts.filter(
          (thought) => !(thought.spaceId === spaceId && thought.deletedAt),
        );
        data.comments = data.comments.filter(
          (comment) => !docIds.has(comment.docId),
        );
        data.versions = data.versions.filter(
          (version) => !docIds.has(version.docId),
        );
      });
    },

    async search(spaceId, query) {
      const data = store.read();
      const normalized = query.trim().toLowerCase();
      if (!normalized) return [];
      const docs: SearchResult[] = [];
      for (const node of data.nodes) {
        if (node.spaceId !== spaceId || node.deletedAt || node.kind !== 'note')
          continue;
        const text = htmlToText(node.content);
        if (
          !node.title.toLowerCase().includes(normalized) &&
          !text.toLowerCase().includes(normalized)
        )
          continue;
        docs.push({
          id: node.id,
          type: 'doc',
          spaceId,
          title: node.title,
          excerpt: excerptAround(text, normalized),
          archived: node.archived,
          creator: node.creator,
        });
      }
      const thoughts: SearchResult[] = [];
      for (const thought of data.thoughts) {
        if (
          thought.spaceId !== spaceId ||
          thought.deletedAt ||
          thought.convertedDocId ||
          !htmlToText(thought.content).toLowerCase().includes(normalized)
        )
          continue;
        const text = htmlToText(thought.content);
        thoughts.push({
          id: thought.id,
          type: 'thought',
          spaceId,
          title: `随想 ${thought.createdAt.slice(0, 10)}`,
          excerpt: excerptAround(text, normalized),
          archived: thought.archived,
          creator: 'me',
        });
      }
      // 文档在前，同类按标题；与设计阶段的排序结果一致，但不依赖比较器的调用顺序。
      const byTitle = (a: SearchResult, b: SearchResult) =>
        a.title.localeCompare(b.title);
      return clone([...docs.sort(byTitle), ...thoughts.sort(byTitle)]);
    },

    async getOverview(spaceId) {
      const space = currentSpace(store.read(), spaceId);
      await sweepArchives();
      const data = store.read();
      const timestamp = now();
      const since = new Date(timestamp);
      since.setDate(since.getDate() - 365);
      since.setHours(0, 0, 0, 0);
      const notes = data.nodes.filter(
        (node) => node.spaceId === spaceId && node.kind === 'note',
      );
      const notesById = new Map(notes.map((node) => [node.id, node]));
      const agentEvents = data.events
        .filter((event) => event.spaceId === spaceId)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const agentDocTimes = new Map<string, number[]>();
      for (const event of agentEvents) {
        if (!event.docId) continue;
        const times = agentDocTimes.get(event.docId) ?? [];
        times.push(Date.parse(event.at));
        agentDocTimes.set(event.docId, times);
      }
      const recordedByAgent = (docId: string, at: string) =>
        agentDocTimes
          .get(docId)
          ?.some((time) => Math.abs(time - Date.parse(at)) < 5 * 60_000) ??
        false;
      const versionsByDoc = new Map<string, DocVersion[]>();
      for (const version of data.versions) {
        if (!notesById.has(version.docId)) continue;
        const list = versionsByDoc.get(version.docId) ?? [];
        list.push(version);
        versionsByDoc.set(version.docId, list);
      }

      const events: SpaceActivityEvent[] = [];
      const record = (event: SpaceActivityEvent) => {
        const at = Date.parse(event.at);
        if (
          !Number.isFinite(at) ||
          at > timestamp.getTime() ||
          at < since.getTime()
        )
          return;
        events.push(event);
      };

      record({
        id: `act-space-${space.id}`,
        at: space.createdAt,
        kind: 'space',
        title: `创建了空间「${space.name}」`,
      });
      for (const node of notes) {
        if (node.deletedAt) continue;
        const title = node.title || '未命名文档';
        if (!recordedByAgent(node.id, node.createdAt)) {
          const label = node.creator === 'alter' ? 'Alter 新建了' : '新建';
          record({
            id: `act-doc-create-${node.id}`,
            at: node.createdAt,
            kind: 'doc',
            title: `${label}《${title}》`,
            label,
            docId: node.id,
            docTitle: title,
          });
        }
        const versions = versionsByDoc.get(node.id) ?? [];
        for (const version of versions) {
          if (recordedByAgent(node.id, version.at)) continue;
          const label = version.author === 'alter' ? 'Alter 更新了' : '更新';
          record({
            id: `act-doc-version-${version.id}`,
            at: version.at,
            kind: 'doc',
            title: `${label}《${title}》`,
            label,
            docId: node.id,
            docTitle: title,
          });
        }
        const savedAt = (at: string) =>
          versions.some(
            (version) =>
              Math.abs(Date.parse(version.at) - Date.parse(at)) < 5 * 60_000,
          );
        if (
          Date.parse(node.updatedAt) - Date.parse(node.createdAt) > HOUR &&
          !recordedByAgent(node.id, node.updatedAt) &&
          !savedAt(node.updatedAt)
        ) {
          record({
            id: `act-doc-update-${node.id}`,
            at: node.updatedAt,
            kind: 'doc',
            title: `更新《${title}》`,
            label: '更新',
            docId: node.id,
            docTitle: title,
          });
        }
      }
      for (const thought of data.thoughts) {
        if (thought.spaceId !== spaceId || thought.deletedAt) continue;
        const text = excerpt(htmlToText(thought.content), 36);
        const title = text ? `记录随想「${text}」` : '记录了一条随想';
        const note = thought.convertedDocId
          ? notesById.get(thought.convertedDocId)
          : undefined;
        record({
          id: `act-thought-${thought.id}`,
          at: thought.createdAt,
          kind: 'thought',
          title,
          label: title,
          docId: thought.convertedDocId,
          docTitle: note?.title || undefined,
        });
      }
      for (const comment of data.comments) {
        const note = notesById.get(comment.docId);
        if (!note || note.deletedAt) continue;
        const label = `${comment.author === 'alter' ? 'Alter ' : ''}评论`;
        const docTitle = note.title || '未命名文档';
        record({
          id: `act-comment-${comment.id}`,
          at: comment.createdAt,
          kind: 'comment',
          title: `${label}《${docTitle}》`,
          label,
          detail: excerpt(comment.body),
          docId: note.id,
          docTitle,
        });
      }
      for (const task of data.tasks) {
        if (task.spaceId !== spaceId) continue;
        const title = `提出事项「${task.title}」`;
        const note = task.docId ? notesById.get(task.docId) : undefined;
        record({
          id: `act-task-${task.id}`,
          at: task.createdAt,
          kind: 'task',
          title,
          label: title,
          detail: task.detail,
          docId: task.docId,
          docTitle: note?.title || undefined,
        });
      }
      for (const event of agentEvents) {
        record({
          id: `act-agent-${event.id}`,
          at: event.at,
          kind: 'agent',
          title: event.title,
          detail: event.detail,
          docId: event.docId,
          agentEventId: event.id,
        });
      }

      events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const daily = new Map<string, SpaceActivityEvent[]>();
      for (const event of events) {
        const date = localDayKey(event.at);
        const items = daily.get(date) ?? [];
        items.push(event);
        daily.set(date, items);
      }
      const activity = [...daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, dayEvents]) => ({
          date,
          count: dayEvents.length,
          events: dayEvents,
        }));
      const tasks: SpaceTask[] = clone(
        data.tasks
          .filter((task) => task.spaceId === spaceId)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      );
      const milestones: Milestone[] = clone(
        data.milestones.filter((milestone) => milestone.spaceId === spaceId),
      );
      const overview: SpaceOverview = {
        activity,
        recentDocs: data.nodes
          .filter(
            (node) =>
              node.spaceId === spaceId &&
              !node.deletedAt &&
              node.kind === 'note',
          )
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, 6)
          .map((node) => decorate(node, timestamp)),
        agentEvents: clone(agentEvents),
        tasks,
        milestones,
      };
      return overview;
    },

    async listAgents() {
      return clone(store.read().agents);
    },

    async createAgent(input: CreateAgentInput) {
      return store.update((data) => {
        const name = input.name.trim();
        if (!name) throw new Error('协作者名称不能为空');
        const agent: Agent = {
          id: createId('ag'),
          name,
          role: input.role.trim(),
          createdAt: toIso(now()),
        };
        const description = input.description?.trim();
        if (description) agent.description = description;
        const model = input.model?.trim();
        if (model) agent.model = model;
        const permissions = normalizeAgentPermissions(input.permissions);
        if (permissions.length) agent.permissions = permissions;
        data.agents.push(agent);
        return clone(agent);
      });
    },

    async listDirectories(path) {
      const normalized = normalizeDirectoryPath(path);
      const resolved = resolveDirectoryPath(normalized);
      if (!resolved) throw new Error('目录不存在');
      let dirents: Dirent[];
      try {
        dirents = await readdir(resolved, { withFileTypes: true });
      } catch {
        throw new Error('目录不存在');
      }
      const entries: DirectoryEntry[] = dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .sort(compareDirectoryNames)
        .map((name) => ({
          path: `${normalized === '/' ? '' : normalized}/${name}`,
          name,
        }));
      return { path: normalized, entries };
    },
  };
}
