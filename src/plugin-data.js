/**
 * Demo-data cleanup for the migrated Space plugin.
 *
 * The plugin started as a design-stage port backed by `@alter/mock-space`,
 * whose seed created demo spaces, notes, comments, versions and hub snapshots.
 * Space content is now implemented for real in the Alter product, so the plugin
 * must not present that seed as user data:
 *
 * - demo spaces and their documents/comments/versions/events are removed from
 *   browser storage, while non-demo content created by the user is kept;
 * - hub snapshots keep only the implemented plugins (overview/config) and drop
 *   the seeded matters, journey, observations and usage;
 * - summaries the user generated through the plugin are kept in a plugin-owned
 *   record so clearing a seeded snapshot does not lose them.
 */
/** Same identity as `@alter/mock-space` seed; kept local so this module is
 * dependency-free and testable outside the bundle. */
const DEFAULT_SPACE_ID = 'sp-inbox';
const DEFAULT_SPACE_NAME = '日常';

const SPACE_KEY = 'alter.space.mock.v4';
const HUB_KEY = 'alter.space.hub.v1';
const SUMMARY_KEY = 'alter.space.plugin.summary.v1';
/** Marker for the one-time migration away from the pre-implementation demo data. */
const CLEANUP_KEY = 'alter.space.plugin.cleanup.v2';
const CLEANUP_VALUE = '2';

/** Spaces created by the design-stage seed; they are not user content. */
const DEMO_SPACE_IDS = new Set(['sp-cognition', 'sp-ai', 'sp-writing']);
/** Collaborators created by the design-stage seed. */
const DEMO_AGENT_IDS = new Set(['ag-alter', 'ag-researcher']);

const IMPLEMENTED_PLUGINS = [
  {
    id: 'overview',
    label: '概览',
    description: '空间近况、活动与使用统计',
    builtin: true,
    required: true,
    enabled: true,
  },
  {
    id: 'config',
    label: '配置',
    description: '空间信息、协作者与插件',
    builtin: true,
    required: true,
    enabled: true,
  },
];

const LIST_FIELDS = [
  'nodes',
  'thoughts',
  'comments',
  'versions',
  'agents',
  'tasks',
  'events',
  'milestones',
];

/** Empty journey value shared by cleaned snapshots. */
const EMPTY_JOURNEY = {
  vision: '',
  shortTerm: '',
  longTerm: '',
  principles: '',
  background: '',
  updatedAt: '',
  nodes: [],
};

function browserStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeRead(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Best-effort migration marker.
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Plugin data is browser-local and best-effort; the session keeps working.
  }
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function defaultSpace(now) {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    goal: '',
    directories: [],
    collaboratorIds: [],
    isDefault: true,
    order: 0,
    createdAt: now,
    archivedAt: null,
  };
}

/** The clean first-run state: only the default space. */
function emptyDatabase(now) {
  return {
    version: 1,
    spaces: [defaultSpace(now)],
    nodes: [],
    thoughts: [],
    comments: [],
    versions: [],
    agents: [],
    tasks: [],
    events: [],
    milestones: [],
  };
}

/** Keep user spaces and content, normalize the default space, drop the seed. */
function normalizeDatabase(raw, now) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.spaces))
    return emptyDatabase(now);

  const spaces = raw.spaces
    .filter((space) => space && typeof space.id === 'string')
    .filter((space) => !DEMO_SPACE_IDS.has(space.id))
    .map((space) =>
      space.id === DEFAULT_SPACE_ID
        ? {
            ...space,
            name: DEFAULT_SPACE_NAME,
            goal: '',
            directories: [],
            collaboratorIds: [],
            isDefault: true,
            archivedAt: null,
          }
        : space,
    );
  if (!spaces.some((space) => space.id === DEFAULT_SPACE_ID))
    spaces.unshift(defaultSpace(now));

  const spaceIds = new Set(spaces.map((space) => space.id));
  const nodes = listOf(raw.nodes).filter((node) => spaceIds.has(node?.spaceId));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    version: 1,
    spaces,
    nodes,
    thoughts: listOf(raw.thoughts).filter((thought) =>
      spaceIds.has(thought?.spaceId),
    ),
    comments: listOf(raw.comments).filter((comment) =>
      nodeIds.has(comment?.docId),
    ),
    versions: listOf(raw.versions).filter((version) =>
      nodeIds.has(version?.docId),
    ),
    agents: listOf(raw.agents).filter(
      (agent) => !DEMO_AGENT_IDS.has(agent?.id),
    ),
    tasks: listOf(raw.tasks).filter((task) => spaceIds.has(task?.spaceId)),
    events: listOf(raw.events).filter((event) => spaceIds.has(event?.spaceId)),
    milestones: listOf(raw.milestones).filter((milestone) =>
      spaceIds.has(milestone?.spaceId),
    ),
  };
}

function cleanSnapshot(previous, summary) {
  const policy =
    previous?.policy === 'judge' || previous?.policy === 'autonomous'
      ? previous.policy
      : 'ask';
  return {
    matters: [],
    journey: { ...EMPTY_JOURNEY },
    observations: [],
    plugins: IMPLEMENTED_PLUGINS.map((plugin) => ({ ...plugin })),
    policy,
    onboarding: 'complete',
    summary: summary ?? { content: '', updatedAt: '' },
    usage: [],
  };
}

/**
 * Rewrite browser storage so the design-stage demo seed is gone and only the
 * implemented hub surface remains.
 * @param storage - browser localStorage-like target; omit for vitest-free use.
 */
export function cleanDemoData(storage = browserStorage()) {
  if (!storage) return;
  const now = new Date().toISOString();
  const migrated = safeRead(storage, CLEANUP_KEY) === CLEANUP_VALUE;
  // The plugin shipped only the design-stage seed before the real Space
  // business existed, including default-space thoughts, archived documents and
  // trash items. The first migration resets browser storage entirely; later
  // loads keep whatever the user created after that point.
  let raw = migrated ? readJson(storage, SPACE_KEY) : emptyDatabase(now);
  let summaries = migrated ? (readJson(storage, SUMMARY_KEY) ?? {}) : {};
  const database = normalizeDatabase(raw, now);
  writeJson(storage, SPACE_KEY, database);

  const previousHub = migrated ? (readJson(storage, HUB_KEY) ?? {}) : {};
  const hub = {};
  for (const space of database.spaces)
    hub[space.id] = cleanSnapshot(previousHub[space.id], summaries[space.id]);
  for (const id of Object.keys(summaries)) if (!hub[id]) delete summaries[id];
  writeJson(storage, HUB_KEY, hub);
  writeJson(storage, SUMMARY_KEY, summaries);
  safeWrite(storage, CLEANUP_KEY, CLEANUP_VALUE);
}

/**
 * Wrap the design-stage service so hub reads/re-summaries stay on the
 * implemented surface (matters/journey/observations/usage are not implemented).
 * @param service - service created by `createSpaceService`.
 * @param storage - browser localStorage-like target.
 */
export function prepareSpaceService(service, storage = browserStorage()) {
  const hub = service.hub;
  const getOverview = service.getOverview.bind(service);
  const summaries = storage ? (readJson(storage, SUMMARY_KEY) ?? {}) : {};
  return {
    ...service,
    async getOverview(spaceId) {
      const overview = await getOverview(spaceId);
      // Agent activity, tasks and milestones are not implemented in this batch;
      // keep doc/thought/comment records (real user activity) only.
      const activity = (overview.activity ?? [])
        .map((day) => {
          const events = (day.events ?? []).filter(
            (event) => event.kind !== 'agent' && event.kind !== 'task',
          );
          return { ...day, count: events.length, events };
        })
        .filter((day) => day.events.length > 0);
      return {
        ...overview,
        activity,
        agentEvents: [],
        tasks: [],
        milestones: [],
      };
    },
    hub: {
      ...hub,
      async get(spaceId) {
        const snapshot = await hub.get(spaceId);
        return cleanSnapshot(snapshot, summaries[spaceId]);
      },
      async summarize(spaceId) {
        await hub.summarize(spaceId);
        const snapshot = await hub.get(spaceId);
        summaries[spaceId] = snapshot.summary;
        if (storage) writeJson(storage, SUMMARY_KEY, summaries);
      },
      remove(spaceId) {
        delete summaries[spaceId];
        if (storage) writeJson(storage, SUMMARY_KEY, summaries);
        return hub.remove(spaceId);
      },
    },
  };
}
