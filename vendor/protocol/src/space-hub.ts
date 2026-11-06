export type MatterStatus =
  | 'planning'
  | 'waiting'
  | 'running'
  | 'completed'
  | 'abandoned';
export type DecisionPolicy = 'ask' | 'judge' | 'autonomous';
export interface DecisionQuestion {
  id: string;
  title: string;
  description: string;
  options?: string[];
  required: boolean;
}
export interface Matter {
  id: string;
  title: string;
  description: string;
  status: MatterStatus;
  source: 'user' | 'agent';
  agent: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  unread: boolean;
  plan: string;
  reason: string;
  docIds: string[];
  questions: DecisionQuestion[];
  answers: Record<string, string>;
  timeline: { id: string; title: string; detail: string; at: string }[];
  execution: 'idle' | 'active' | 'stopped' | 'finished';
}
export interface Journey {
  vision: string;
  shortTerm: string;
  longTerm: string;
  principles: string;
  background: string;
  updatedAt: string;
  nodes: {
    id: string;
    title: string;
    detail: string;
    state: 'past' | 'failed' | 'current' | 'future';
    date: string;
    matterId?: string;
  }[];
}
export interface Observation {
  id: string;
  kind: 'behavior' | 'judgment';
  title: string;
  detail: string;
  count: number;
  evidence: { title: string; date: string; docId?: string }[];
  accepted: boolean;
  skill?: { name: string; instructions: string };
}
export interface SpacePluginManifest {
  id: string;
  label: string;
  description: string;
  builtin: boolean;
  required: boolean;
  enabled: boolean;
  content?: string;
}
export interface HubSnapshot {
  matters: Matter[];
  journey: Journey;
  observations: Observation[];
  plugins: SpacePluginManifest[];
  policy: DecisionPolicy;
  onboarding: 'pending' | 'skipped' | 'complete';
  summary: { content: string; updatedAt: string };
  usage: {
    date: string;
    actions: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    model: string;
  }[];
}
export interface SpaceHubService {
  get(spaceId: string): Promise<HubSnapshot>;
  createMatter(
    spaceId: string,
    title: string,
    description: string,
    source?: 'user' | 'agent',
  ): Promise<Matter>;
  setMatterStatus(
    spaceId: string,
    id: string,
    status: MatterStatus,
    reason?: string,
  ): Promise<void>;
  answerMatter(
    spaceId: string,
    id: string,
    answers: Record<string, string>,
  ): Promise<void>;
  readMatter(spaceId: string, id: string): Promise<void>;
  saveJourney(
    spaceId: string,
    patch: Partial<
      Pick<Journey, 'vision' | 'shortTerm' | 'longTerm' | 'principles'>
    >,
  ): Promise<void>;
  introduce(
    spaceId: string,
    background: string,
    vision: string,
    next: string,
  ): Promise<void>;
  skipIntroduction(spaceId: string): Promise<void>;
  acceptObservation(
    spaceId: string,
    id: string,
    accepted: boolean,
  ): Promise<void>;
  extractSkill(
    spaceId: string,
    id: string,
    instructions: string,
  ): Promise<void>;
  setPolicy(spaceId: string, policy: DecisionPolicy): Promise<void>;
  setPluginEnabled(
    spaceId: string,
    id: string,
    enabled: boolean,
  ): Promise<void>;
  discoverPlugin(
    spaceId: string,
    label: string,
    purpose: string,
  ): Promise<SpacePluginManifest>;
  savePluginContent(
    spaceId: string,
    id: string,
    content: string,
  ): Promise<void>;
  summarize(spaceId: string): Promise<void>;
  remove(spaceId: string): void;
}
