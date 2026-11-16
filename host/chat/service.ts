/**
 * Conversation records over the Space authority side tables.
 *
 * Chats and their space/page references are plugin-owned sidecar data
 * (`chats` / `chat_refs`), not part of `SpaceStoreData`: reference validity
 * depends on live space and page state, so every read resolves it from the
 * current collections instead of persisting it. The DSH session itself stays
 * owned by DSH; this service only stores the binding.
 *
 * @module @alter-dsh/space/chat/service
 */
import type {
  Chat,
  ChatKind,
  ChatPatch,
  ChatRef,
  ChatRefState,
  ChatService,
  CreateChatInput,
  CreateChatRefInput,
} from '@alter/protocol';
import type {
  ChatRecord,
  ChatRefRecord,
  SpaceStoreHandle,
} from '../persistence/store.js';

/** Clock; tests inject a fixed one. */
export type ChatClock = () => Date;

/** Options for the chat service: the store and the identity it writes as. */
export interface ChatServiceOptions {
  store: SpaceStoreHandle;
  /** Write identity for reference attribution; the browser is `me`. */
  actor?: 'user' | 'alter';
  now?: ChatClock;
}

/** Stable id prefix per table. */
function newId(prefix: string, now: Date): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${now.getTime().toString(36)}${random}`;
}

/** Resolve current reachability of one referenced space. */
function spaceState(
  data: ReturnType<SpaceStoreHandle['read']>,
  spaceId: string,
): ChatRefState {
  const space = data.spaces.find((item) => item.id === spaceId);
  if (space === undefined) return 'missing';
  return space.archivedAt !== null ? 'archived' : 'current';
}

/** Resolve current reachability and live label of one referenced page. */
function nodeState(
  data: ReturnType<SpaceStoreHandle['read']>,
  nodeId: string,
): { state: ChatRefState; title: string } {
  const node = data.nodes.find((item) => item.id === nodeId);
  if (node === undefined) return { state: 'missing', title: '' };
  if (node.deletedAt !== null) return { state: 'missing', title: node.title };
  if (node.archived) return { state: 'archived', title: node.title };
  return { state: 'current', title: node.title };
}

/**
 * Compose the chat service over one opened store.
 *
 * Identity note: chats are DSH-session bookkeeping, so the service is
 * composed once per identity stack but only the user stack is exposed over
 * RPC; Agent tools never reach it.
 */
export function createChatService(options: ChatServiceOptions): ChatService {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const actor = options.actor ?? 'user';

  function assemble(record: ChatRecord, refs: readonly ChatRefRecord[]): Chat {
    const data = store.read();
    const resolvedRefs: ChatRef[] = refs.map((ref) => {
      const live = ref.nodeId
        ? nodeState(data, ref.nodeId)
        : { state: spaceState(data, ref.spaceId), title: '' };
      const label =
        ref.nodeId && live.title !== '' ? live.title : ref.label;
      return {
        id: ref.id,
        kind: ref.nodeId === null ? 'space' : 'page',
        spaceId: ref.spaceId,
        nodeId: ref.nodeId,
        label,
        addedAt: ref.addedAt,
        addedBy: ref.addedBy,
        state: live.state,
      };
    });
    return {
      id: record.id,
      kind: record.kind,
      sessionId: record.sessionId,
      title: record.title,
      sideOf: record.sideOf,
      refs: resolvedRefs,
      quote: record.quote,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function readChat(id: string): Chat | undefined {
    const record = store.getChat(id);
    if (record === undefined) return undefined;
    return assemble(record, store.listChatRefs(id));
  }

  function resolveRefs(
    inputs: readonly CreateChatRefInput[],
    existing: readonly ChatRefRecord[],
    timestamp: Date,
  ): ChatRefRecord[] {
    const byTarget = new Map<string, ChatRefRecord>();
    for (const ref of existing) {
      byTarget.set(`${ref.spaceId}\u0000${ref.nodeId ?? ''}`, ref);
    }
    const resolved: ChatRefRecord[] = [];
    for (const input of inputs) {
      const spaceId = input.spaceId ?? '';
      const nodeId = input.nodeId ?? null;
      const key = `${spaceId}\u0000${nodeId ?? ''}`;
      const previous = byTarget.get(key);
      // 同一输入集合内的重复目标也去重：先解析到的身份保留。
      if (previous !== undefined) {
        resolved.push(previous);
        continue;
      }
      const data = store.read();
      const label =
        nodeId !== null
          ? (data.nodes.find((item) => item.id === nodeId)?.title ?? '')
          : (data.spaces.find((item) => item.id === spaceId)?.name ?? '');
      const created: ChatRefRecord = {
        id: newId('cr', timestamp),
        chatId: '',
        kind: nodeId === null ? 'space' : 'page',
        spaceId,
        nodeId,
        label,
        addedAt: timestamp.toISOString(),
        addedBy: actor === 'alter' ? 'alter' : 'me',
      };
      byTarget.set(key, created);
      resolved.push(created);
    }
    return resolved;
  }

  /** One existing reference row, as an input the resolver dedups against. */
  function refInputOf(ref: ChatRefRecord): CreateChatRefInput {
    return {
      kind: ref.nodeId === null ? 'space' : 'page',
      spaceId: ref.spaceId,
      nodeId: ref.nodeId,
    };
  }

  function chatOf(record: ChatRecord): Chat | undefined {
    return readChat(record.id);
  }

  return {
    async listChats(filter) {
      const records = store.listChats();
      const chats: Chat[] = [];
      for (const record of records) {
        if (filter?.kind !== undefined && record.kind !== filter.kind) continue;
        const chat = chatOf(record);
        if (chat !== undefined) chats.push(chat);
      }
      return chats;
    },

    async getChat(id) {
      return readChat(id);
    },

    async createChat(input: CreateChatInput) {
      const timestamp = now();
      const kind: ChatKind = input.kind;
      const record: ChatRecord = {
        id: newId('ch', timestamp),
        kind,
        sessionId: input.sessionId ?? null,
        title: input.title ?? '',
        sideOf:
          kind === 'side' && input.sideOf
            ? {
                sessionId: input.sideOf.sessionId,
                title: input.sideOf.title ?? '',
              }
            : null,
        quote: input.quote ?? null,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
      };
      await store.putChat(record);
      const refs = resolveRefs(
        input.refs ?? [],
        [],
        timestamp,
      ).map((ref) => ({ ...ref, chatId: record.id }));
      await store.replaceChatRefs(record.id, refs);
      const chat = readChat(record.id);
      if (chat === undefined)
        throw new Error('chat/create-failed: 会话记录写入失败');
      return chat;
    },

    async updateChat(id, patch: ChatPatch) {
      const record = store.getChat(id);
      if (record === undefined)
        throw new Error('chat/not-found: 会话记录不存在');
      const timestamp = now();
      const next: ChatRecord = {
        ...record,
        sessionId:
          patch.sessionId === undefined ? record.sessionId : patch.sessionId,
        title: patch.title === undefined ? record.title : patch.title,
        updatedAt: timestamp.toISOString(),
      };
      await store.putChat(next);
      const chat = readChat(id);
      if (chat === undefined)
        throw new Error('chat/create-failed: 会话记录写入失败');
      return chat;
    },

    async deleteChat(id) {
      await store.deleteChat(id);
    },

    async setChatRefs(id, refs) {
      const record = store.getChat(id);
      if (record === undefined)
        throw new Error('chat/not-found: 会话记录不存在');
      const timestamp = now();
      const existing = store.listChatRefs(id);
      const next = resolveRefs(refs, existing, timestamp);
      await store.replaceChatRefs(id, next);
      const chat = readChat(id);
      if (chat === undefined)
        throw new Error('chat/create-failed: 会话记录写入失败');
      return chat;
    },

    async addChatRef(id, ref) {
      const record = store.getChat(id);
      if (record === undefined)
        throw new Error('chat/not-found: 会话记录不存在');
      const existing = store.listChatRefs(id);
      const duplicate = existing.some(
        (item) =>
          item.spaceId === (ref.spaceId ?? '') &&
          (item.nodeId ?? null) === (ref.nodeId ?? null),
      );
      if (duplicate) return readChat(id)!;
      const timestamp = now();
      // 追加语义：既有引用作为输入一并解析，身份在去重中保留。
      const next = resolveRefs(
        [...existing.map(refInputOf), ref],
        existing,
        timestamp,
      );
      await store.replaceChatRefs(id, next);
      await store.putChat({ ...record, updatedAt: timestamp.toISOString() });
      const chat = readChat(id);
      if (chat === undefined)
        throw new Error('chat/create-failed: 会话记录写入失败');
      return chat;
    },

    async listChatsForRef(ref) {
      const spaceId = ref.spaceId;
      const nodeId = ref.nodeId ?? null;
      const rows = store.listChatRefsForTarget(spaceId, nodeId);
      const data = store.read();
      const ids = new Set<string>();
      const chats: Chat[] = [];
      for (const row of rows) {
        if (ids.has(row.chatId)) continue;
        ids.add(row.chatId);
        const record = store.getChat(row.chatId);
        if (record === undefined) continue;
        // A page ref inside an archived page keeps the row but the page is
        // still reachable, so the chat is listed; a deleted page hides it.
        if (nodeId !== null) {
          const node = data.nodes.find((item) => item.id === nodeId);
          if (node === undefined || node.deletedAt !== null) continue;
        } else {
          const space = data.spaces.find((item) => item.id === spaceId);
          if (space === undefined) continue;
        }
        const chat = chatOf(record);
        if (chat !== undefined) chats.push(chat);
      }
      return chats.sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
    },
  };
}
