/**
 * Observable chat store for the Space conversation integrations.
 *
 * One store instance per plugin load: it keeps every chat record the Host
 * returned, indexes page chats by their DSH session id (so a session-scoped
 * UI can ask "which space/page does this conversation reference"), and keeps
 * the side-chat history list. Ref validity is whatever the Host resolved at
 * read time; `refresh()` re-reads.
 */
import type {
  Chat,
  ChatKind,
  ChatPatch,
  CreateChatRefInput,
} from '@alter/protocol';
import { createSnapshotStore, type ObservableSnapshot } from './snapshot';
import type { SpaceChatClient } from './client';

/** Client actions over the chat store. */
export interface ChatStoreActions {
  /** Re-read every chat from the Host. */
  refresh(): Promise<void>;
  /** Create a page conversation and index it by its session. */
  createPageChat(input: {
    spaceId: string;
    nodeId: string | null;
    sessionId: string;
    title?: string;
  }): Promise<Chat>;
  /** Create a side conversation (branch) for a main session. */
  createSideChat(input: {
    sessionId: string;
    sideOf: { sessionId: string; title: string };
    quote?: string | null;
    refs?: readonly CreateChatRefInput[];
    title?: string;
  }): Promise<Chat>;
  /** Replace the reference set of the chat bound to a session. */
  setRefs(sessionId: string, refs: readonly CreateChatRefInput[]): Promise<void>;
  /** Rename the chat bound to a session (side history rename). */
  rename(chatId: string, title: string): Promise<void>;
  /** Delete a chat record by id (does not touch the DSH session). */
  remove(chatId: string): Promise<void>;
  /** Bind/patch the record of a session (title sync, session id backfill). */
  patch(chatId: string, patch: ChatPatch): Promise<void>;
}

export interface ChatStore {
  /** Every chat record, newest activity first. */
  readonly chats: ObservableSnapshot<readonly Chat[]>;
  /** Side conversations only, newest first (history tab). */
  readonly sideChats: ObservableSnapshot<readonly Chat[]>;
  /** Page conversations only, newest first. */
  readonly pageChats: ObservableSnapshot<readonly Chat[]>;
  /** The chat record bound to a DSH session id, if any. */
  chatOfSession(sessionId: string): Chat | undefined;
  /** Snapshot-based observable for one session's chat binding. */
  chatSourceOfSession(
    sessionId: string,
  ): ObservableSnapshot<Chat | undefined>;
  readonly actions: ChatStoreActions;
}

export function createChatStore(client: SpaceChatClient): ChatStore {
  const chats = createSnapshotStore<readonly Chat[]>([]);
  let loaded = false;

  function sortNewest(list: readonly Chat[]): Chat[] {
    return [...list].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }

  async function refresh(): Promise<void> {
    const next = await client.listChats();
    chats.set(sortNewest(next));
    loaded = true;
  }

  function byKind(kind: ChatKind): Chat[] {
    return chats.getSnapshot().filter((chat) => chat.kind === kind);
  }

  const store: ChatStore = {
    chats,
    sideChats: {
      getSnapshot: () => byKind('side'),
      subscribe: chats.subscribe,
    },
    pageChats: {
      getSnapshot: () => byKind('page'),
      subscribe: chats.subscribe,
    },
    chatOfSession(sessionId) {
      return chats
        .getSnapshot()
        .find((chat) => chat.sessionId === sessionId);
    },
    chatSourceOfSession(sessionId) {
      return {
        getSnapshot: () => store.chatOfSession(sessionId),
        subscribe: chats.subscribe,
      };
    },
    actions: {
      refresh: () => {
        if (!loaded) return refresh();
        return refresh();
      },
      async createPageChat(input) {
        const chat = await client.createChat({
          kind: 'page',
          spaceId: input.spaceId,
          nodeId: input.nodeId,
          sessionId: input.sessionId,
          ...(input.title === undefined ? {} : { title: input.title }),
          // A space-level conversation references the space, not a page.
          refs: [
            input.nodeId === null
              ? { kind: 'space', spaceId: input.spaceId }
              : {
                  kind: 'page',
                  spaceId: input.spaceId,
                  nodeId: input.nodeId,
                },
          ],
        });
        await refresh();
        return chat;
      },
      async createSideChat(input) {
        const chat = await client.createChat({
          kind: 'side',
          sessionId: input.sessionId,
          sideOf: input.sideOf,
          quote: input.quote ?? null,
          ...(input.refs === undefined ? {} : { refs: input.refs }),
          ...(input.title === undefined ? {} : { title: input.title }),
        });
        await refresh();
        return chat;
      },
      async setRefs(sessionId, refs) {
        const chat = store.chatOfSession(sessionId);
        if (!chat) return;
        await client.setChatRefs(chat.id, refs);
        await refresh();
      },
      async rename(chatId, title) {
        await client.updateChat(chatId, { title });
        await refresh();
      },
      async remove(chatId) {
        await client.deleteChat(chatId);
        await refresh();
      },
      async patch(chatId, patch) {
        await client.updateChat(chatId, patch);
        await refresh();
      },
    },
  };
  void refresh().catch(() => undefined);
  return store;
}
