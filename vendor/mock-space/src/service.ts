import { createSpaceHubService } from './hub';
import { listDirectories as listMockDirectories } from './directories';
import {
  createSeedDatabase,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  type SpaceDatabase,
} from './seed';
import type {
  Agent,
  Comment,
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
} from './types';

const STORAGE_KEY = 'alter.space.mock.v4';
const DAY = 86_400_000;
const HOUR = 3_600_000;

interface ServiceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => Date;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createId(prefix: string) {
  const value =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${value}`;
}

function toIso(date: Date) {
  return date.toISOString();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const LEGACY_DEFAULT_SPACE_NAMES = ['Inbox / 仓库', 'Inbox'];

/**
 * 默认空间是系统内置的固定空间，早期版本存下的数据需要补齐标记与名称，
 * 否则改名后旧数据仍会显示旧名称，或失去「不可归档、不可删除」的保护。
 */
function promoteDefaultSpace(spaces: Space[]): Space[] {
  return spaces.map((space) => {
    if (space.id !== DEFAULT_SPACE_ID) return space;
    return {
      ...space,
      name: LEGACY_DEFAULT_SPACE_NAMES.includes(space.name)
        ? DEFAULT_SPACE_NAME
        : space.name,
      isDefault: true,
      archivedAt: null,
    };
  });
}

export function htmlToText(html: string) {
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

function localDayKey(value: Date | string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function excerpt(value: string, max = 48) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createSpaceService(options: ServiceOptions = {}): SpaceService {
  const now = options.now ?? (() => new Date());
  const storage =
    options.storage ??
    (typeof localStorage === 'undefined' ? undefined : localStorage);

  function load(): SpaceDatabase {
    if (!storage) return createSeedDatabase();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return createSeedDatabase();
      const parsed = JSON.parse(raw) as SpaceDatabase;
      if (parsed.version !== 1) return createSeedDatabase();
      parsed.spaces = promoteDefaultSpace(
        parsed.spaces.map((space) => ({
          ...space,
          archivedAt: space.archivedAt ?? null,
        })),
      );
      parsed.comments = parsed.comments.map((comment) => ({
        ...comment,
        editedAt: comment.editedAt ?? null,
        supplements: comment.supplements ?? [],
      }));
      return parsed;
    } catch {
      return createSeedDatabase();
    }
  }

  const db = load();

  function persist() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      // A local mock should keep working when storage is unavailable.
    }
  }

  function currentSpace(id: string) {
    const space = db.spaces.find((item) => item.id === id);
    if (!space) throw new Error('空间不存在');
    return space;
  }

  function currentNode(id: string) {
    const node = db.nodes.find((item) => item.id === id);
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

  function sweepArchives() {
    const timestamp = now();
    let changed = false;
    for (const node of db.nodes) {
      if (
        node.kind !== 'note' ||
        node.deletedAt ||
        node.archived ||
        node.pinned
      )
        continue;
      if (activityOf(node, timestamp) <= 0) {
        node.archived = true;
        node.archivedBy = 'agent';
        node.archivedAt = toIso(timestamp);
        node.activity = 0;
        node.activityAt = toIso(timestamp);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function descendantsOf(id: string) {
    const result: SpaceNode[] = [];
    const queue = db.nodes.filter((node) => node.parentId === id);
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      result.push(next);
      queue.push(...db.nodes.filter((node) => node.parentId === next.id));
    }
    return result;
  }

  function recordVersion(node: SpaceNode, timestamp: Date) {
    const versions = db.versions.filter((version) => version.docId === node.id);
    const latest = versions.sort(
      (a, b) => Date.parse(b.at) - Date.parse(a.at),
    )[0];
    if (latest && timestamp.getTime() - Date.parse(latest.at) < 5 * 60_000)
      return;
    db.versions.push({
      id: createId('ver'),
      docId: node.id,
      title: node.title,
      content: node.content,
      author: 'me',
      at: toIso(timestamp),
    });
  }

  const service: SpaceService = {
    hub: createSpaceHubService({
      space: currentSpace,
      nodes: (id) => db.nodes.filter((node) => node.spaceId === id),
      thoughts: (id) => db.thoughts.filter((thought) => thought.spaceId === id),
      events: (id) => db.events.filter((event) => event.spaceId === id),
      storage,
      now,
    }),
    async listSpaces() {
      return clone(db.spaces)
        .filter((space) => !space.archivedAt)
        .sort(
          (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt),
        );
    },

    async getSpace(id) {
      const space = db.spaces.find((item) => item.id === id);
      return space ? clone(space) : undefined;
    },

    async createSpace(input: NewSpaceInput) {
      const name = input.name.trim();
      if (!name) throw new Error('空间名称不能为空');
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
          db.spaces.reduce((max, item) => Math.max(max, item.order), 0) + 1,
        createdAt: toIso(now()),
        archivedAt: null,
      };
      db.spaces.push(space);
      persist();
      return clone(space);
    },

    async updateSpace(id, patch: SpacePatch) {
      const space = currentSpace(id);
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
      persist();
      return clone(space);
    },

    async archiveSpace(id) {
      const space = currentSpace(id);
      if (space.isDefault) throw new Error('默认空间不能归档');
      if (!space.archivedAt) {
        space.archivedAt = toIso(now());
        persist();
      }
      return clone(space);
    },

    async unarchiveSpace(id) {
      const space = currentSpace(id);
      if (space.archivedAt) {
        space.archivedAt = null;
        space.order =
          db.spaces.reduce((max, item) => Math.max(max, item.order), 0) + 1;
        persist();
      }
      return clone(space);
    },

    async listArchivedSpaces() {
      return clone(db.spaces)
        .filter((space) => space.archivedAt)
        .sort(
          (a, b) =>
            Date.parse(b.archivedAt ?? '') - Date.parse(a.archivedAt ?? ''),
        );
    },

    async deleteSpace(id) {
      const space = currentSpace(id);
      if (space.isDefault) throw new Error('默认空间不能删除');
      const docIds = new Set(
        db.nodes.filter((node) => node.spaceId === id).map((node) => node.id),
      );
      service.hub.remove(id);
      db.spaces = db.spaces.filter((item) => item.id !== id);
      db.nodes = db.nodes.filter((node) => node.spaceId !== id);
      db.thoughts = db.thoughts.filter((thought) => thought.spaceId !== id);
      db.comments = db.comments.filter((comment) => !docIds.has(comment.docId));
      db.versions = db.versions.filter((version) => !docIds.has(version.docId));
      db.tasks = db.tasks.filter((task) => task.spaceId !== id);
      db.events = db.events.filter((event) => event.spaceId !== id);
      db.milestones = db.milestones.filter((item) => item.spaceId !== id);
      persist();
    },

    async reorderSpaces(ids) {
      ids.forEach((id, index) => {
        const space = db.spaces.find((item) => item.id === id);
        if (space) space.order = index;
      });
      persist();
      return clone(db.spaces).sort((a, b) => a.order - b.order);
    },

    async listNodes(spaceId) {
      sweepArchives();
      const timestamp = now();
      return db.nodes
        .filter((node) => node.spaceId === spaceId && !node.deletedAt)
        .map((node) => decorate(node, timestamp));
    },

    async getNode(id) {
      sweepArchives();
      const node = db.nodes.find((item) => item.id === id && !item.deletedAt);
      return node ? decorate(node) : undefined;
    },

    async createNode(input: {
      spaceId: string;
      parentId?: string | null;
      kind: NodeKind;
      title?: string;
    }) {
      currentSpace(input.spaceId);
      const parentId = input.parentId ?? null;
      if (input.kind === 'folder' && parentId)
        throw new Error('文件夹只能创建在根目录');
      if (parentId) {
        const parent = currentNode(parentId);
        if (parent.spaceId !== input.spaceId)
          throw new Error('上级目录不属于当前空间');
      }
      const timestamp = toIso(now());
      const siblings = db.nodes.filter(
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
          input.title?.trim() ?? (input.kind === 'folder' ? '新建文件夹' : ''),
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
        order: siblings.reduce((min, item) => Math.min(min, item.order), 0) - 1,
      };
      db.nodes.push(node);
      persist();
      return clone(node);
    },

    async saveNode(id, patch: NodePatch) {
      const node = currentNode(id);
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
      if (contentChanged) recordVersion(node, timestamp);
      persist();
      return decorate(node, timestamp);
    },

    async moveNode(id, target) {
      const node = currentNode(id);
      currentSpace(target.spaceId);
      if (node.kind === 'folder' && target.parentId)
        throw new Error('文件夹只能位于根目录');
      if (target.parentId) {
        const parent = currentNode(target.parentId);
        if (parent.spaceId !== target.spaceId)
          throw new Error('目标位置不属于目标空间');
        if (parent.id === id) throw new Error('不能移动到自身');
        if (descendantsOf(id).some((item) => item.id === parent.id))
          throw new Error('不能移动到自己的子层级');
      }
      const subtree = [node, ...descendantsOf(id)];
      for (const item of subtree) item.spaceId = target.spaceId;
      node.parentId = target.parentId;
      if (target.order !== undefined) node.order = target.order;
      node.updatedAt = toIso(now());
      persist();
      return clone(node);
    },

    async setPinned(id, pinned) {
      const node = currentNode(id);
      node.pinned = pinned;
      persist();
      return decorate(node);
    },

    async setArchived(id, archived) {
      const node = currentNode(id);
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
      persist();
      return decorate(node);
    },

    async deleteNode(id) {
      const node = currentNode(id);
      const timestamp = toIso(now());
      node.deletedAt = timestamp;
      node.deletedRoot = true;
      node.originalParentId = node.parentId;
      for (const item of descendantsOf(id)) {
        item.deletedAt = timestamp;
        item.deletedRoot = false;
      }
      persist();
    },

    async restoreNode(id) {
      const node = currentNode(id);
      if (!node.deletedAt) return decorate(node);
      const deletedAt = node.deletedAt;
      const originalParent = node.originalParentId;
      node.deletedAt = null;
      node.deletedRoot = false;
      node.originalParentId = null;
      if (originalParent) {
        const parent = db.nodes.find((item) => item.id === originalParent);
        node.parentId = parent && !parent.deletedAt ? parent.id : null;
      }
      for (const item of db.nodes) {
        if (item.deletedAt === deletedAt && item.id !== node.id) {
          item.deletedAt = null;
          item.deletedRoot = false;
        }
      }
      persist();
      return clone(node);
    },

    async recordOpen(id) {
      const node = currentNode(id);
      const timestamp = now();
      node.unread = false;
      const activity = activityOf(node, timestamp);
      const canCredit =
        !node.lastOpenCreditAt ||
        timestamp.getTime() - Date.parse(node.lastOpenCreditAt) > HOUR;
      node.activity = clamp(activity + (canCredit ? 5 : 0), 0, 100);
      node.activityAt = toIso(timestamp);
      if (canCredit) node.lastOpenCreditAt = toIso(timestamp);
      persist();
      return decorate(node, timestamp);
    },

    async listComments(docId) {
      return clone(
        db.comments
          .filter((comment) => comment.docId === docId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    },

    async addComment(input: {
      docId: string;
      body: string;
      quote?: string | null;
    }) {
      const node = currentNode(input.docId);
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
      db.comments.push(comment);
      persist();
      return clone(comment);
    },

    async updateComment(id, patch) {
      const comment = db.comments.find((item) => item.id === id);
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
      persist();
      return clone(comment);
    },

    async addCommentSupplement(id, body) {
      const comment = db.comments.find((item) => item.id === id);
      if (!comment) throw new Error('评论不存在');
      const content = body.trim();
      if (!content) throw new Error('补充内容不能为空');
      comment.supplements.push({
        id: createId('cs'),
        author: 'me',
        body: content,
        createdAt: toIso(now()),
      });
      persist();
      return clone(comment);
    },

    async deleteComment(id) {
      const index = db.comments.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('评论不存在');
      db.comments.splice(index, 1);
      persist();
    },

    async resolveComment(id) {
      const comment = db.comments.find((item) => item.id === id);
      if (!comment) throw new Error('评论不存在');
      comment.status = 'resolved';
      comment.resolvedAt = toIso(now());
      persist();
      return clone(comment);
    },

    async listVersions(docId) {
      return clone(
        db.versions
          .filter((version) => version.docId === docId)
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      );
    },

    async restoreVersion(docId, versionId) {
      const node = currentNode(docId);
      const version = db.versions.find((item) => item.id === versionId);
      if (!version || version.docId !== docId) throw new Error('版本不存在');
      const timestamp = now();
      recordVersion(node, timestamp);
      node.content = version.content;
      node.title = version.title;
      node.updatedAt = toIso(timestamp);
      node.activity = clamp(activityOf(node, timestamp) + 20, 0, 100);
      node.activityAt = toIso(timestamp);
      node.lastEditCreditAt = toIso(timestamp);
      persist();
      return decorate(node, timestamp);
    },

    async listThoughts(spaceId, listOptions) {
      return clone(
        db.thoughts
          .filter(
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
      currentSpace(input.spaceId);
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
      db.thoughts.push(thought);
      persist();
      return clone(thought);
    },

    async updateThought(id, content) {
      const thought = db.thoughts.find((item) => item.id === id);
      if (!thought) throw new Error('随想不存在');
      const trimmed = content.trim();
      if (!trimmed) throw new Error('随想内容不能为空');
      thought.content = trimmed;
      thought.updatedAt = toIso(now());
      persist();
      return clone(thought);
    },

    async setThoughtArchived(id, archived) {
      const thought = db.thoughts.find((item) => item.id === id);
      if (!thought) throw new Error('随想不存在');
      thought.archived = archived;
      thought.archivedAt = archived ? toIso(now()) : null;
      persist();
      return clone(thought);
    },

    async deleteThought(id) {
      const thought = db.thoughts.find((item) => item.id === id);
      if (!thought) throw new Error('随想不存在');
      thought.deletedAt = toIso(now());
      persist();
    },

    async restoreThought(id) {
      const thought = db.thoughts.find((item) => item.id === id);
      if (!thought) throw new Error('随想不存在');
      thought.deletedAt = null;
      persist();
      return clone(thought);
    },

    async moveThought(id, spaceId) {
      const thought = db.thoughts.find((item) => item.id === id);
      if (!thought) throw new Error('随想不存在');
      currentSpace(spaceId);
      thought.spaceId = spaceId;
      persist();
      return clone(thought);
    },

    async convertThought(id) {
      const thought = db.thoughts.find((item) => item.id === id);
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
          db.nodes
            .filter(
              (item) =>
                item.spaceId === thought.spaceId &&
                item.parentId === null &&
                !item.deletedAt,
            )
            .reduce((min, item) => Math.min(min, item.order), 0) - 1,
      };
      db.nodes.push(node);
      thought.convertedDocId = node.id;
      persist();
      return { thought: clone(thought), node: clone(node) };
    },

    async listDeleted(spaceId) {
      return {
        nodes: clone(
          db.nodes
            .filter((node) => node.spaceId === spaceId && node.deletedRoot)
            .sort(
              (a, b) =>
                Date.parse(b.deletedAt ?? '') - Date.parse(a.deletedAt ?? ''),
            ),
        ),
        thoughts: clone(
          db.thoughts
            .filter(
              (thought) =>
                thought.spaceId === spaceId && Boolean(thought.deletedAt),
            )
            .sort(
              (a, b) =>
                Date.parse(b.deletedAt ?? '') - Date.parse(a.deletedAt ?? ''),
            ),
        ),
      };
    },

    async emptyTrash(spaceId) {
      currentSpace(spaceId);
      const docIds = new Set(
        db.nodes
          .filter((node) => node.spaceId === spaceId && node.deletedAt)
          .map((node) => node.id),
      );
      db.nodes = db.nodes.filter(
        (node) => !(node.spaceId === spaceId && node.deletedAt),
      );
      db.thoughts = db.thoughts.filter(
        (thought) => !(thought.spaceId === spaceId && thought.deletedAt),
      );
      db.comments = db.comments.filter((comment) => !docIds.has(comment.docId));
      db.versions = db.versions.filter((version) => !docIds.has(version.docId));
      persist();
    },

    async search(spaceId, query) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return [];
      const results: SearchResult[] = [];
      for (const node of db.nodes) {
        if (node.spaceId !== spaceId || node.deletedAt || node.kind !== 'note')
          continue;
        const text = htmlToText(node.content);
        if (
          !node.title.toLowerCase().includes(normalized) &&
          !text.toLowerCase().includes(normalized)
        )
          continue;
        results.push({
          id: node.id,
          type: 'doc',
          spaceId,
          title: node.title,
          excerpt: excerptAround(text, normalized),
          archived: node.archived,
          creator: node.creator,
        });
      }
      for (const thought of db.thoughts) {
        if (
          thought.spaceId !== spaceId ||
          thought.deletedAt ||
          thought.convertedDocId ||
          !htmlToText(thought.content).toLowerCase().includes(normalized)
        )
          continue;
        const text = htmlToText(thought.content);
        results.push({
          id: thought.id,
          type: 'thought',
          spaceId,
          title: `随想 ${thought.createdAt.slice(0, 10)}`,
          excerpt: excerptAround(text, normalized),
          archived: thought.archived,
          creator: 'me',
        });
      }
      return clone(
        results.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'doc' ? -1 : 1;
          return a.title.localeCompare(b.title);
        }),
      );
    },

    async getOverview(spaceId) {
      const space = currentSpace(spaceId);
      sweepArchives();
      const timestamp = now();
      const since = new Date(timestamp);
      since.setDate(since.getDate() - 365);
      since.setHours(0, 0, 0, 0);
      const notes = db.nodes.filter(
        (node) => node.spaceId === spaceId && node.kind === 'note',
      );
      const notesById = new Map(notes.map((node) => [node.id, node]));
      const agentEvents = db.events
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
      const versionsByDoc = new Map<string, typeof db.versions>();
      for (const version of db.versions) {
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
      for (const thought of db.thoughts) {
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
      for (const comment of db.comments) {
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
      for (const task of db.tasks) {
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
        if (!date) continue;
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
        db.tasks
          .filter((task) => task.spaceId === spaceId)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      );
      const milestones: Milestone[] = clone(
        db.milestones.filter((milestone) => milestone.spaceId === spaceId),
      );
      const overview: SpaceOverview = {
        activity,
        recentDocs: db.nodes
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
      return clone(db.agents);
    },

    async createAgent(input) {
      const name = input.name.trim();
      if (!name) throw new Error('协作者名称不能为空');
      const agent: Agent = {
        id: createId('ag'),
        name,
        role: input.role.trim(),
        createdAt: toIso(now()),
      };
      db.agents.push(agent);
      persist();
      return clone(agent);
    },

    async listDirectories(path) {
      return listMockDirectories(path);
    },
  };

  return service;
}
