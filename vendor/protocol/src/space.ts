export type Creator = 'me' | 'alter';
export type NodeKind = 'folder' | 'note';
export type ArchiveSource = 'agent' | 'user' | 'system';

/**
 * Write identity at the authority boundary: the browser speaks for `user`,
 * Agent tool ports are bound to `alter`. Attribution is derived from this
 * identity at creation time and is never transferable afterwards.
 */
export type SpaceActor = 'user' | 'alter';

/** Entity creator vocabulary derived from the write identity (one mapping). */
export function creatorOf(actor: SpaceActor): Creator {
  return actor === 'alter' ? 'alter' : 'me';
}

/** Archive/event source vocabulary derived from the write identity. */
export function archiveSourceOf(actor: SpaceActor): ArchiveSource {
  return actor === 'alter' ? 'agent' : 'user';
}

export interface Space {
  id: string;
  name: string;
  goal: string;
  directories: string[];
  collaboratorIds: string[];
  icon?: string;
  color?: string;
  isDefault: boolean;
  order: number;
  createdAt: string;
  archivedAt: string | null;
}

/** Capability keys a collaborator can be granted inside a space. */
export type AgentPermission = 'read' | 'edit' | 'comment' | 'manage';

export interface Agent {
  id: string;
  name: string;
  role: string;
  /** Free-form description of what the collaborator is good at. */
  description?: string;
  /** Preferred model label; product metadata, not a runtime binding yet. */
  model?: string;
  /** Space-scoped capability grants; product metadata, not enforced yet. */
  permissions?: AgentPermission[];
  createdAt: string;
}

/** Payload for creating a collaborator from a space's configuration page. */
export interface CreateAgentInput {
  name: string;
  role: string;
  description?: string;
  model?: string;
  permissions?: AgentPermission[];
}

export interface SpaceNode {
  id: string;
  spaceId: string;
  kind: NodeKind;
  title: string;
  parentId: string | null;
  creator: Creator;
  pinned: boolean;
  archived: boolean;
  archivedBy: ArchiveSource | null;
  archivedAt: string | null;
  deletedAt: string | null;
  deletedRoot: boolean;
  originalParentId: string | null;
  unread: boolean;
  content: string;
  activity: number;
  activityAt: string;
  lastOpenCreditAt: string | null;
  lastEditCreditAt: string | null;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface Thought {
  id: string;
  spaceId: string;
  content: string;
  /** Write-identity attribution; rows persisted before it load as `me`. */
  creator: Creator;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  convertedDocId: string | null;
}

export interface CommentSupplement {
  id: string;
  author: Creator;
  body: string;
  createdAt: string;
}

/**
 * Position of a comment inside one document block.
 *
 * `offset`/`length` are plain-text offsets within the top-level block's
 * flattened text (inline text as-is, hard breaks as a newline, nested blocks
 * joined by newlines — the same convention as the editor). Stored comments
 * always carry the anchor captured when the comment was created; comments
 * written before the anchor model load with `anchor: null`.
 */
export interface CommentAnchor {
  blockId: string;
  offset: number;
  length: number;
}

export interface Comment {
  id: string;
  docId: string;
  author: Creator;
  body: string;
  quote: string | null;
  anchor: CommentAnchor | null;
  /**
   * `deleted` is a terminal soft delete: the row stays in `listComments` as a
   * tombstone (body/quote/supplements kept) and the UI shows it in the history
   * panel. A body write that deletes the quoted text turns `open` comments into
   * tombstones and leaves existing ones untouched; writes against a tombstone
   * are no-ops that return it unchanged. There is no per-comment permanent
   * delete — a tombstone only goes away with its document (space delete or
   * trash emptying).
   */
  status: 'open' | 'resolved' | 'deleted';
  createdAt: string;
  resolvedAt: string | null;
  /** When the soft delete happened; `null` for every other status. */
  deletedAt: string | null;
  editedAt: string | null;
  supplements: CommentSupplement[];
}

export interface DocVersion {
  id: string;
  docId: string;
  title: string;
  content: string;
  author: Creator;
  at: string;
}

export interface AgentEvent {
  id: string;
  spaceId: string;
  title: string;
  detail: string;
  at: string;
  docId: string | null;
  taskId: string | null;
  /**
   * Who produced the event, in the archive-source vocabulary. Rows persisted
   * before it load as `agent` (events historically summarized Alter's work).
   */
  source: ArchiveSource;
}

export interface SpaceTask {
  id: string;
  spaceId: string;
  title: string;
  detail: string;
  status: 'pending' | 'in_progress';
  owner: Creator;
  docId: string | null;
  createdAt: string;
}

export interface Milestone {
  id: string;
  spaceId: string;
  title: string;
  detail: string;
  status: 'done' | 'current' | 'next';
  period: string;
}

export interface SearchResult {
  id: string;
  type: 'doc' | 'thought';
  spaceId: string;
  title: string;
  excerpt: string;
  archived: boolean;
  creator: Creator;
}

export interface NewSpaceInput {
  name: string;
  goal?: string;
  directories?: string[];
  collaboratorIds?: string[];
  icon?: string;
  color?: string;
}

export interface SpacePatch {
  name?: string;
  goal?: string;
  directories?: string[];
  collaboratorIds?: string[];
  icon?: string;
  color?: string;
}

export interface NodePatch {
  title?: string;
  content?: string;
}

export type SpaceActivityKind =
  | 'space'
  | 'doc'
  | 'thought'
  | 'comment'
  | 'task'
  | 'agent';

export interface SpaceActivityEvent {
  id: string;
  at: string;
  kind: SpaceActivityKind;
  title: string;
  /** 不含文档名的动作文案；文档引用由 docTitle 单独呈现。 */
  label?: string;
  detail?: string;
  docId?: string | null;
  docTitle?: string;
  agentEventId?: string | null;
}

export interface SpaceActivityDay {
  /** 本地时区的 YYYY-MM-DD。 */
  date: string;
  count: number;
  events: SpaceActivityEvent[];
}

export interface SpaceOverview {
  /** 过去一年内有记录的日期，按日期升序，仅包含有活动的日期。 */
  activity: SpaceActivityDay[];
  recentDocs: SpaceNode[];
  agentEvents: AgentEvent[];
  tasks: SpaceTask[];
  milestones: Milestone[];
}

export interface DirectoryEntry {
  path: string;
  name: string;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
}

export interface SpaceService {
  hub: import('./space-hub.js').SpaceHubService;
  listSpaces(): Promise<Space[]>;
  getSpace(id: string): Promise<Space | undefined>;
  createSpace(input: NewSpaceInput): Promise<Space>;
  updateSpace(id: string, patch: SpacePatch): Promise<Space>;
  archiveSpace(id: string): Promise<Space>;
  unarchiveSpace(id: string): Promise<Space>;
  listArchivedSpaces(): Promise<Space[]>;
  deleteSpace(id: string): Promise<void>;
  reorderSpaces(ids: string[]): Promise<Space[]>;

  listNodes(spaceId: string): Promise<SpaceNode[]>;
  getNode(id: string): Promise<SpaceNode | undefined>;
  createNode(input: {
    spaceId: string;
    parentId?: string | null;
    kind: NodeKind;
    title?: string;
  }): Promise<SpaceNode>;
  saveNode(id: string, patch: NodePatch): Promise<SpaceNode>;
  moveNode(
    id: string,
    target: { spaceId: string; parentId: string | null; order?: number },
  ): Promise<SpaceNode>;
  setPinned(id: string, pinned: boolean): Promise<SpaceNode>;
  setArchived(id: string, archived: boolean): Promise<SpaceNode>;
  deleteNode(id: string): Promise<void>;
  restoreNode(id: string): Promise<SpaceNode>;
  recordOpen(id: string): Promise<SpaceNode>;

  listComments(docId: string): Promise<Comment[]>;
  addComment(input: {
    docId: string;
    body: string;
    quote?: string | null;
    anchor?: CommentAnchor | null;
  }): Promise<Comment>;
  updateComment(
    id: string,
    patch: {
      body?: string;
      quote?: string | null;
      anchor?: CommentAnchor | null;
    },
  ): Promise<Comment>;
  addCommentSupplement(id: string, body: string): Promise<Comment>;
  deleteComment(id: string): Promise<void>;
  resolveComment(id: string): Promise<Comment>;
  listVersions(docId: string): Promise<DocVersion[]>;
  restoreVersion(docId: string, versionId: string): Promise<SpaceNode>;

  listThoughts(
    spaceId: string,
    options?: { includeArchived?: boolean },
  ): Promise<Thought[]>;
  createThought(input: { spaceId: string; content: string }): Promise<Thought>;
  updateThought(id: string, content: string): Promise<Thought>;
  setThoughtArchived(id: string, archived: boolean): Promise<Thought>;
  deleteThought(id: string): Promise<void>;
  restoreThought(id: string): Promise<Thought>;
  moveThought(id: string, spaceId: string): Promise<Thought>;
  convertThought(id: string): Promise<{ thought: Thought; node: SpaceNode }>;

  listDeleted(spaceId: string): Promise<{
    nodes: SpaceNode[];
    thoughts: Thought[];
  }>;
  /** 永久删除该空间回收站里的全部内容，不可恢复。 */
  emptyTrash(spaceId: string): Promise<void>;
  search(spaceId: string, query: string): Promise<SearchResult[]>;
  getOverview(spaceId: string): Promise<SpaceOverview>;

  listAgents(): Promise<Agent[]>;
  createAgent(input: CreateAgentInput): Promise<Agent>;

  listDirectories(path: string): Promise<DirectoryListing>;
}
