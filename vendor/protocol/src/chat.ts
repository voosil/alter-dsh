/**
 * Conversations around spaces and pages, and the space/page references they
 * carry.
 *
 * A reference names one space or one page and is what the Agent reads on every
 * turn; validity (`valid` / `archived` / `missing`) is derived from current
 * authority state when the record is read, never stored. Side chats are
 * branches of a DSH session and live in the same table, distinguished only by
 * `sideOf`.
 */

/** What one reference points at: a whole space (structure) or one page (content). */
export type ChatRefKind = 'space' | 'page';

/**
 * Current reachability of a reference. `deleted` means the row is gone (page
 * deleted, space removed); `archived` keeps the name readable but the Agent no
 * longer reads it by default.
 */
export type ChatRefState = 'current' | 'archived' | 'missing';

/** Why a chat record exists. */
export type ChatKind =
  /** A page conversation: an ordinary DSH session opened from a space page. */
  | 'page'
  /** A side conversation: a branch of a main conversation. */
  | 'side';

export interface ChatRef {
  /** Reference identity, stable for the lifetime of its chat record. */
  id: string;
  kind: ChatRefKind;
  /** Owning space; for a page reference this is the page's space. */
  spaceId: string;
  /** Page id; absent for a space reference. */
  nodeId: string | null;
  /** Display name captured when the reference was added. */
  label: string;
  addedAt: string;
  /** Who added this reference. */
  addedBy: 'me' | 'alter';
  /** Derived from current authority state on read. */
  state: ChatRefState;
}

export interface Chat {
  id: string;
  kind: ChatKind;
  /** DSH session carrying the messages; `null` only for a side chat still being forked. */
  sessionId: string | null;
  title: string;
  /** Main conversation a side chat branched from; absent for a page chat. */
  sideOf: {
    sessionId: string;
    title: string;
  } | null;
  refs: ChatRef[];
  /** Quoted text that opened a side chat. */
  quote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create one chat record. */
export interface CreateChatInput {
  kind: ChatKind;
  /** Page chats: the page the conversation is about. */
  spaceId?: string;
  nodeId?: string | null;
  sessionId?: string | null;
  title?: string;
  sideOf?: { sessionId: string; title?: string } | null;
  quote?: string | null;
  /** Which space/page the conversation was opened from, if any. */
  refs?: readonly CreateChatRefInput[];
}

export interface CreateChatRefInput {
  kind: ChatRefKind;
  spaceId?: string;
  nodeId?: string | null;
}

/** Patch one chat record; absent fields keep their value. */
export interface ChatPatch {
  sessionId?: string | null;
  title?: string;
}

export interface ChatService {
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