/**
 * Minimal seed for the plugin bundle only.
 *
 * The plugin must never ship the design-stage demo seed (演示空间、笔记、随想、
 * 活动与事项) now that Space's real business lives in the Alter product. This
 * module replaces `@alter/mock-space`'s seed at build time — see the
 * `dsh-space:minimal-mock-seed` resolver in `build/build.mjs` — so even a fresh
 * browser profile with empty storage starts from a single default space.
 */
export const DEFAULT_SPACE_ID = 'sp-inbox';
export const DEFAULT_SPACE_NAME = '日常';

export function createSeedDatabase(now = new Date()) {
  const createdAt = now.toISOString();
  return {
    version: 1,
    spaces: [
      {
        id: DEFAULT_SPACE_ID,
        name: DEFAULT_SPACE_NAME,
        goal: '',
        directories: [],
        collaboratorIds: [],
        isDefault: true,
        order: 0,
        createdAt,
        archivedAt: null,
      },
    ],
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
