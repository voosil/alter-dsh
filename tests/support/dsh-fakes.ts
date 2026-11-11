/**
 * DSH Host service doubles.
 *
 * The Host plugin talks to DSH through structural seams (`workspaceRegistry`,
 * `tools`, `approval`, `credentials`); the doubles here implement exactly the
 * surface the plugin reads, so the plugin code runs unmodified. They are
 * deliberately small: anything the plugin does not call is not modelled.
 */
import type { WorkspaceEntityLike, WorkspaceRegistryLike } from '../../host/workspace/sync.js';

/** Credential record shape the Host settings store reads and writes. */
export interface CredentialRecord {
  kind: string;
  payload?: unknown;
}

/**
 * In-memory DSH credential service.
 *
 * Tracks every record so tests can assert the bearer token never reaches a
 * file, and exposes the raw map for direct inspection.
 */
export interface FakeCredentials {
  records: Map<string, CredentialRecord>;
  readRecord(key: string): Promise<CredentialRecord | undefined>;
  modifyRecord(
    key: string,
    mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined> | CredentialRecord | undefined,
  ): Promise<CredentialRecord | undefined>;
  deleteRecord(key: string): Promise<boolean>;
}

export function fakeCredentials(): FakeCredentials {
  const records = new Map<string, CredentialRecord>();
  return {
    records,
    async readRecord(key) {
      return records.get(key);
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return next;
    },
    async deleteRecord(key) {
      return records.delete(key);
    },
  };
}

/** Approval service double: records requests and answers with `allow`. */
export interface FakeApproval {
  requests: Array<{ title?: string; detail?: string; [key: string]: unknown }>;
  request(input: Record<string, unknown>): Promise<{ approved: boolean }>;
}

/**
 * @param allow - verdict every request receives.
 */
export function fakeApproval(allow = true): FakeApproval {
  const requests: FakeApproval['requests'] = [];
  return {
    requests,
    async request(input) {
      requests.push(input as FakeApproval['requests'][number]);
      return { approved: allow };
    },
  };
}

/** One registered tool; the Host registers by name and calls `run`. */
export interface RegisteredTool {
  name: string;
  description?: string;
  input?: unknown;
  run: (input: unknown, context?: unknown) => Promise<unknown>;
}

/** Tool registry double matching the Host's `register`/`unregister` seam. */
export interface FakeTools {
  tools: Map<string, RegisteredTool>;
  register(tool: RegisteredTool): () => void;
  unregister?(name: string): void;
  get(name: string): RegisteredTool | undefined;
}

export function fakeTools(): FakeTools {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    register(tool) {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
    unregister(name) {
      tools.delete(name);
    },
    get(name) {
      return tools.get(name);
    },
  };
}

/** In-memory DSH workspace entity. */
export class FakeWorkspace implements WorkspaceEntityLike {
  readonly id: string;
  readonly path: string;
  readonly sessionIds: string[];
  title: string;

  constructor(
    id: string,
    path: string,
    title: string,
    sessionIds: string[] = [],
  ) {
    this.id = id;
    this.path = path;
    this.title = title;
    this.sessionIds = sessionIds;
  }

  async setTitle(title: string): Promise<void> {
    this.title = title;
  }
}

/** In-memory DSH workspace registry with the bridge's Host-service contract. */
export class FakeWorkspaceRegistry implements WorkspaceRegistryLike {
  private sequence = 0;
  readonly byId = new Map<string, FakeWorkspace>();

  /** Register a workspace directly, as DSH's native creation flow would. */
  seed(path: string, title: string, sessionIds: string[] = []): FakeWorkspace {
    const entity = new FakeWorkspace(`ws-${++this.sequence}`, path, title, sessionIds);
    this.byId.set(entity.id, entity);
    return entity;
  }

  async create(path: string, title?: string): Promise<FakeWorkspace> {
    const existing = this.list().find((workspace) => workspace.path === path);
    if (existing !== undefined) return existing as FakeWorkspace;
    const fallback = path.split('/').filter(Boolean).pop() ?? path;
    return this.seed(path, title ?? fallback);
  }

  get(id: string): FakeWorkspace | undefined {
    return this.byId.get(id);
  }

  list(): FakeWorkspace[] {
    return [...this.byId.values()];
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async resolveByPath(path: string): Promise<FakeWorkspace | undefined> {
    return this.list().find((workspace) => workspace.path === path);
  }
}