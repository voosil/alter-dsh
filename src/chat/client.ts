/**
 * Client-side chat contracts shared by the Space conversation integrations.
 *
 * The authoritative shapes live in `@alter/protocol` (`vendor/protocol/src/chat.ts`).
 * This module adds the browser-only surface: the RPC client factory and the
 * observable store other UI modules consume. It must stay free of runtime
 * imports from `@deepseek-ai/*` — the client bundle is self-contained.
 */
import type {
  Chat,
  ChatKind,
  ChatPatch,
  ChatRef,
  ChatRefKind,
  ChatRefState,
  CreateChatInput,
  CreateChatRefInput,
} from '@alter/protocol';

export type {
  Chat,
  ChatKind,
  ChatPatch,
  ChatRef,
  ChatRefKind,
  ChatRefState,
  CreateChatInput,
  CreateChatRefInput,
};

/** Structural RPC caller implemented by `ctx.connection.rpc`. */
export interface ChatRpcCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } }
  >;
}

/** Browser client over the Host `chat.*` endpoints. */
export interface SpaceChatClient {
  listChats(filter?: { kind?: ChatKind }): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | undefined>;
  createChat(input: CreateChatInput): Promise<Chat>;
  updateChat(id: string, patch: ChatPatch): Promise<Chat>;
  deleteChat(id: string): Promise<void>;
  setChatRefs(id: string, refs: readonly CreateChatRefInput[]): Promise<Chat>;
  addChatRef(id: string, ref: CreateChatRefInput): Promise<Chat>;
  listChatsForRef(ref: {
    spaceId: string;
    nodeId?: string | null;
  }): Promise<Chat[]>;
}

export function createSpaceChatClient(rpc: ChatRpcCaller): SpaceChatClient {
  /** Error the Host reported, carrying its stable code. */
  async function call<T>(endpoint: string, args: unknown[]): Promise<T> {
    // Same channel pair as `src/client/rpc.ts` (`/api` + `alter-space`).
    const result = await rpc.call('/api', 'alter-space', { op: endpoint, args });
    if (!result.ok) throw new Error(result.error.message);
    // Two envelope levels: the Connection result wraps the Host's own
    // `{ value }` / `{ error }` answer. Skipping the inner unwrap hands callers
    // the envelope object instead of the payload — an array-shaped endpoint
    // then returned an object and every `.map`/`.filter` on it threw.
    const body = result.value;
    if (body !== null && typeof body === 'object') {
      const record = body as { value?: unknown; error?: unknown };
      if (record.error !== undefined) {
        const failure = record.error as { code?: string; message?: string };
        throw new Error(
          typeof failure.message === 'string' ? failure.message : '空间操作失败',
        );
      }
      return (record.value ?? undefined) as T;
    }
    return body as T;
  }
  return {
    listChats: (filter) =>
      call('chat.listChats', filter ? [filter] : []).then((chats) =>
        (chats as Chat[] | null) ?? [],
      ),
    getChat: (id) =>
      call('chat.getChat', [id]).then((chat) => (chat as Chat | null) ?? undefined),
    createChat: (input) => call('chat.createChat', [input]),
    updateChat: (id, patch) => call('chat.updateChat', [id, patch]),
    deleteChat: (id) => call('chat.deleteChat', [id]).then(() => undefined),
    setChatRefs: (id, refs) => call('chat.setChatRefs', [id, refs]),
    addChatRef: (id, ref) => call('chat.addChatRef', [id, ref]),
    listChatsForRef: (ref) =>
      call('chat.listChatsForRef', [ref]).then((chats) =>
        (chats as Chat[] | null) ?? [],
      ),
  };
}
