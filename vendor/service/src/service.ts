/** Space content business service. */
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  Agent,
  AgentEvent,
  AgentPermission,
  Comment,
  CreateAgentInput,
  DirectoryEntry,
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

/** Extract the plain text of one AST block tree (alter-doc/1). */
function astBlockText(block: unknown): string[] {
  if (typeof block !== 'object' || block === null || Array.isArray(block))
    return [];
  const record = block as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const inline of record.content) {
      if (typeof inline !== 'object' || inline === null) continue;
      const node = inline as Record<string, unknown>;
      if (node.type === 'text' && typeof node.text === 'string')
        parts.push(node.text);
      else if (node.type === 'hardBreak') parts.push('\n');
    }
  }
  if (Array.isArray(record.children))
    for (const child of record.children) parts.push(...astBlockText(child));
  for (const key of ['alt', 'caption', 'title', 'description']) {
    const value = record.attrs;
    if (typeof value !== 'object' || value === null) continue;
    const text = (value as Record<string, unknown>)[key];
    if (typeof text === 'string' && text.trim() !== '') parts.push(text);
  }
  return parts;
}

/**
 * Read the searchable text of a document body. AST documents store JSON, so
 * the HTML stripper would otherwise leak node types and ids into search.
 */
function contentText(content: string) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as { format?: unknown }).format === 'alter-doc/1' &&
        Array.isArray((parsed as { blocks?: unknown }).blocks)
      ) {
        const blocks = (parsed as { blocks: unknown[] }).blocks;
        return blocks
          .flatMap((block) => astBlockText(block))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
    } catch {
      // Not JSON: fall through to the legacy HTML path.
    }
  }
  return htmlToText(content);
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

interface ActivitySource {
  space: Space;
  nodes: SpaceNode[];
  agentEvents: AgentEvent[];
  /** 活动窗口起点（含）。 */
  since: Date;
  /** 业务时钟；不记录尚未发生的事件。 */
  now: Date;
}

/**
 * 「什么值得记」——空间详情活动记录的产品口径。
 *
 * 「值得记」= 没有别的视图承载、且改变了空间面貌的事。活动流由实体当前状态
 * 推导，不是系统日志：
 *
 * 记：
 * - 空间的创建；
 * - 文档的新建（空白草稿不算；Alter 的同一动作由 AgentEvent 呈现，不重复记）；
 * - 用户主动归档文档（闲置自动归档是系统清理，不是用户决定，不记）；
 * - Alter 的行动（AgentEvent 本身已是整理过的结果摘要）。
 *
 * 不记（各自有更合适的去处，数据库与版本历史仍保留全部细节）：
 * - 文档每次编辑、自动保存与版本快照 → 版本历史；
 * - 随想及其修改 → 随想视图（随想转成文档时按「新建文档」记一条）；
 * - 评论的发起、改字与了结 → 文档评论栏；
 * - 事项 → 端口里仍是占位，没有真实数据源；
 * - 打开文档与活跃度、闲置自动归档、系统 / 存储 / 同步行为。
 */
function buildActivityEvents({
  space,
  nodes,
  agentEvents,
  since,
  now,
}: ActivitySource): SpaceActivityEvent[] {
  const events: SpaceActivityEvent[] = [];
  const record = (event: SpaceActivityEvent) => {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at > now.getTime() || at < since.getTime())
      return;
    events.push(event);
  };

  const notes = nodes.filter(
    (node) => node.spaceId === space.id && node.kind === 'note',
  );

  // Alter 的 AgentEvent 已经概括了同一动作，5 分钟内的文档新建不再单独记。
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
      ?.some((time) => Math.abs(time - Date.parse(at)) < 5 * 60_000) ?? false;

  record({
    id: `act-space-${space.id}`,
    at: space.createdAt,
    kind: 'space',
    title: `创建了空间「${space.name}」`,
  });

  for (const node of notes) {
    if (node.deletedAt) continue;
    const title = node.title || '未命名文档';
    // 空白草稿只是「点了一下新建」，还没有内容，不值得记；后来写了字自然补记。
    if (!node.title.trim() && !contentText(node.content).trim()) continue;
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
    // 只有用户主动归档才值得记；闲置自动归档属于系统清理。
    if (node.archivedAt && node.archivedBy === 'user') {
      const label = '归档';
      record({
        id: `act-doc-archive-${node.id}`,
        at: node.archivedAt,
        kind: 'doc',
        title: `${label}《${title}》`,
        label,
        docId: node.id,
        docTitle: title,
      });
    }
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

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
        const text = contentText(node.content);
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
          !contentText(thought.content).toLowerCase().includes(normalized)
        )
          continue;
        const text = contentText(thought.content);
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
      const agentEvents = data.events
        .filter((event) => event.spaceId === spaceId)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const events = buildActivityEvents({
        space,
        nodes: data.nodes,
        agentEvents,
        since,
        now: timestamp,
      });
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
