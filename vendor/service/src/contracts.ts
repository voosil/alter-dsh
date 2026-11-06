/** Internal seams between the store, the content service and the hub service. */
import type {
  Agent,
  AgentEvent,
  Comment,
  DocVersion,
  HubSnapshot,
  Milestone,
  Space,
  SpaceNode,
  SpaceTask,
  Thought,
} from '@alter/protocol';

/** Whole authority for Space product data, persisted as one JSON document. */
export interface SpaceStoreData {
  version: 1;
  spaces: Space[];
  nodes: SpaceNode[];
  thoughts: Thought[];
  comments: Comment[];
  versions: DocVersion[];
  agents: Agent[];
  tasks: SpaceTask[];
  events: AgentEvent[];
  milestones: Milestone[];
  hub: Record<string, HubSnapshot>;
}

export interface SpaceStore {
  /** Live authority; mutate only inside {@link SpaceStore.update}. */
  read(): SpaceStoreData;
  /** Apply one synchronous change and persist it before resolving. */
  update<T>(change: (data: SpaceStoreData) => T): Promise<T>;
  close(): Promise<void>;
}

export interface SpaceStoreOptions {
  directory: string;
  now: () => Date;
}

/** Read side the hub service needs from the content authority. */
export interface SpaceHubReader {
  space(id: string): Space;
  nodes(id: string): SpaceNode[];
  thoughts(id: string): Thought[];
  events(id: string): AgentEvent[];
}

export interface SpaceContentServiceOptions {
  store: SpaceStore;
  hub: import('@alter/protocol').SpaceHubService;
  now: () => Date;
}

export interface SpaceHubServiceOptions {
  store: SpaceStore;
  reader: SpaceHubReader;
  now: () => Date;
}
