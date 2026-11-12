/**
 * Attribution guard: the persistence layer is the single place that enforces
 * write-identity attribution.
 *
 * Every scoped write (`updateAs` / `transactDocument` with an actor) is
 * diffed against the pre-change rows inside the same transaction:
 * - new entities must carry the attribution derived from the current actor;
 * - existing entities keep their attribution forever (supplements append-only);
 * - `archivedBy` may only become `null`, the current actor's archive source,
 *   or `system` (idle auto-archiving is system cleanup on both stacks).
 *
 * Unscoped `update` stays available for non-attribution writes (version
 * trimming, hub snapshots, sidecar-only transactions): existing attribution
 * is still immutable, but creating attribution-bearing entities without an
 * identity is refused. Bootstrap seed data never passes this guard.
 *
 * A violation throws before the write plan is applied, so the store's regular
 * rollback path restores the in-memory snapshot and nothing reaches disk.
 */
import {
  archiveSourceOf,
  creatorOf,
  type SpaceActor,
} from '../../vendor/protocol/src/space.js';
import type { SpaceStoreData } from '../../vendor/service/src/contracts.js';

/** Stable error thrown when a write violates an attribution invariant. */
export class AttributionGuardError extends Error {
  readonly code = 'space/attribution';

  constructor(message: string) {
    super(message);
    this.name = 'AttributionGuardError';
  }
}

/** Collections whose entities carry write-identity attribution. */
const GUARDED_COLLECTIONS = [
  'nodes',
  'thoughts',
  'comments',
  'versions',
  'tasks',
  'events',
] as const;

type GuardedCollection = (typeof GUARDED_COLLECTIONS)[number];

/** Attribution field per collection; events use the archive-source vocabulary. */
const ATTRIBUTION_FIELD: Record<GuardedCollection, string> = {
  nodes: 'creator',
  thoughts: 'creator',
  comments: 'author',
  versions: 'author',
  tasks: 'owner',
  events: 'source',
};

/** Pre-change rows: collection → entity id → serialized JSON. */
export type AttributionBeforeRows = ReadonlyMap<
  string,
  ReadonlyMap<string, string>
>;

type Row = Record<string, unknown>;

function fail(message: string): never {
  throw new AttributionGuardError(message);
}

function label(collection: GuardedCollection, id: string): string {
  return `${collection}[${id}]`;
}

/** The attribution value one new entity must carry for `actor`. */
function expectedAttribution(
  collection: GuardedCollection,
  actor: SpaceActor,
): string {
  return collection === 'events'
    ? archiveSourceOf(actor)
    : creatorOf(actor);
}

/** `archivedBy` targets allowed for the acting identity (or unscoped writes). */
function allowedArchiveSources(actor: SpaceActor | undefined): Set<unknown> {
  const allowed = new Set<unknown>([null, 'system']);
  if (actor !== undefined) allowed.add(archiveSourceOf(actor));
  return allowed;
}

function checkSupplements(
  id: string,
  before: unknown,
  after: unknown,
  actor: SpaceActor | undefined,
): void {
  const previous = Array.isArray(before) ? (before as Row[]) : [];
  const next = Array.isArray(after) ? (after as Row[]) : [];
  if (next.length < previous.length)
    fail(`评论 ${id} 的补充不可删除（只增不改）`);
  for (let index = 0; index < previous.length; index += 1) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index]))
      fail(`评论 ${id} 的补充 #${index} 不可修改（只增不改）`);
  }
  for (let index = previous.length; index < next.length; index += 1) {
    const supplement = next[index]!;
    if (actor === undefined)
      fail(`评论 ${id} 的新补充需要写入身份（updateAs）`);
    if (supplement.author !== creatorOf(actor))
      fail(
        `评论 ${id} 的新补充 author 必须是 ${creatorOf(actor)}（当前写入身份 ${actor}）`,
      );
  }
}

/**
 * Enforce the attribution invariants for one transaction.
 * @param actor - bound write identity; `undefined` for non-attribution writes.
 * @param before - pre-change serialized rows (the store's persisted snapshot).
 * @param after - the live value after the change callback ran.
 */
export function assertAttribution(
  actor: SpaceActor | undefined,
  before: AttributionBeforeRows,
  after: SpaceStoreData,
): void {
  for (const collection of GUARDED_COLLECTIONS) {
    const field = ATTRIBUTION_FIELD[collection];
    const beforeRows = before.get(collection);
    for (const entity of after[collection] as unknown as Row[]) {
      const id = String(entity.id);
      const beforeJson = beforeRows?.get(id);
      if (beforeJson === undefined) {
        // New entity: attribution must equal the current identity's derivation.
        if (actor === undefined)
          fail(
            `新增 ${label(collection, id)} 带归属字段，必须经 updateAs 声明写入身份`,
          );
        const expected = expectedAttribution(collection, actor);
        if (entity[field] !== expected)
          fail(
            `新增 ${label(collection, id)} 的 ${field} 必须是 ${expected}（当前写入身份 ${actor}）`,
          );
        if (collection === 'nodes') {
          const allowed = allowedArchiveSources(actor);
          if (!allowed.has(entity.archivedBy))
            fail(
              `新增 ${label(collection, id)} 的 archivedBy 非法（只允许 null/当前身份来源/system）`,
            );
        }
        continue;
      }
      const afterJson = JSON.stringify(entity);
      if (afterJson === beforeJson) continue;
      const previous = JSON.parse(beforeJson) as Row;
      if (previous[field] !== entity[field])
        fail(`${label(collection, id)} 的 ${field} 写后不可变（归属不可转移）`);
      if (collection === 'comments')
        checkSupplements(id, previous.supplements, entity.supplements, actor);
      if (collection === 'nodes' && previous.archivedBy !== entity.archivedBy) {
        const allowed = allowedArchiveSources(actor);
        if (!allowed.has(entity.archivedBy))
          fail(
            `${label(collection, id)} 的 archivedBy 只能变为 null/当前身份来源/system`,
          );
      }
    }
  }
}

/**
 * Backfill attribution onto rows persisted before the fields existed.
 *
 * - `thought.creator` missing → `me`: thoughts were a user-only surface.
 * - `event.source` missing → `agent`: activity events historically summarized
 *   Alter's work (the overview presents them as agentEvents); there was no
 *   user/system event creation path.
 * - `comment.deletedAt` missing → `null`: soft deletion did not exist before.
 *
 * Runs once while loading rows; the JSON rows tolerate the new fields, so no
 * schema-version bump is needed. The next write of an entity persists them.
 */
export function backfillAttribution(data: SpaceStoreData): void {
  // Comments persisted before the soft-delete tombstone have neither field:
  // they load as live comments (`deletedAt: null`).
  for (const comment of data.comments as unknown as Array<Row & {
    deletedAt?: unknown;
  }>) {
    if (comment.deletedAt === undefined) comment.deletedAt = null;
  }
  for (const thought of data.thoughts as unknown as Row[]) {
    if (thought.creator === undefined) thought.creator = 'me';
  }
  for (const event of data.events as unknown as Row[]) {
    if (event.source === undefined) event.source = 'agent';
  }
}