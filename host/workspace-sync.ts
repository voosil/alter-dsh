/**
 * Host-side bridge between Spaces and DSH workspaces.
 *
 * Product rule: one Space owns exactly one DSH workspace, created from the
 * Space's **primary working directory** (`space.directories[0]`); the
 * remaining entries are reference directories that never create workspaces.
 *
 * The bridge owns the whole lifecycle:
 * - creation: validate + canonicalize the primary directory, reject a
 *   directory already claimed by another Space, then create or adopt the
 *   workspace with the `🪐 <space name>` title;
 * - rename: keep the workspace title in sync with the Space name (uniqueness
 *   enforced locally so DSH's own rename dialog never hits a conflict);
 * - primary-directory change: release the old workspace (keep its
 *   registration, drop the marker) and bind the new directory;
 * - archive: untouched (archive is reversible);
 * - unarchive / startup: reconcile the persisted binding, recreating or
 *   re-adopting a workspace the user removed in DSH;
 * - delete: release the binding without deleting the workspace registration,
 *   so sessions keep their grouping.
 *
 * The binding itself lives in the plugin-owned SQLite sidecar
 * (`workspace_links`), never in the Space entity: DSH workspaces are a
 * Host-level concept and the Space database keeps its own format.
 */
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { NewSpaceInput, Space, SpacePatch } from '@alter/protocol';
import type {
  SpaceStoreHandle,
  SpaceStoreLogger,
  SpaceWorkspaceLink,
} from './store.js';

/** Fixed title prefix marking workspaces owned by a Space. */
export const WORKSPACE_TITLE_PREFIX = '🪐 ';

/** The subset of the DSH workspace entity this bridge needs. */
export interface WorkspaceEntityLike {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  setTitle(title: string): Promise<void>;
}

/** The subset of the DSH `workspaceRegistry` Host service this bridge needs. */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceEntityLike>;
  get(id: string): WorkspaceEntityLike | undefined;
  list(): readonly WorkspaceEntityLike[];
  delete(id: string): Promise<boolean>;
  resolveByPath(path: string): Promise<WorkspaceEntityLike | undefined>;
}

/** Structural check for the Host service before the bridge is enabled. */
export function isWorkspaceRegistryLike(
  value: unknown,
): value is WorkspaceRegistryLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.create === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.list === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.resolveByPath === 'function'
  );
}

/** A bridge failure carrying a stable RPC code (rendered by the Space UI). */
export class WorkspaceSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSyncError';
  }
}

/** The subset of the Space service the bridge drives. */
export interface SpaceServiceLike {
  getSpace(id: string): Promise<Space | undefined>;
  createSpace(input: NewSpaceInput): Promise<Space>;
  updateSpace(id: string, patch: SpacePatch): Promise<Space>;
  unarchiveSpace(id: string): Promise<Space>;
  deleteSpace(id: string): Promise<void>;
}

export interface SpaceWorkspaceSyncOptions {
  /** Live DSH workspace registry Host service. */
  registry: WorkspaceRegistryLike;
  /** Space store owning the `workspace_links` sidecar. */
  store: SpaceStoreHandle;
  /** Host logger; diagnostics are best-effort. */
  logger?: SpaceStoreLogger;
  /** Home directory used to expand `~/…`; tests inject a temp dir. */
  homeDirectory?: string;
  /** Business clock; tests pin it. */
  now?: () => Date;
}

/** The Host-side Space ↔ workspace bridge used by the RPC layer. */
export interface SpaceWorkspaceSync {
  /** Create the Space, creating/adopting its workspace first. */
  createSpace(service: SpaceServiceLike, input: NewSpaceInput): Promise<Space>;
  /** Update the Space, rebinding the workspace when the primary directory moves. */
  updateSpace(
    service: SpaceServiceLike,
    id: string,
    patch: SpacePatch,
  ): Promise<Space>;
  /** Unarchive the Space, then reconcile its workspace binding. */
  unarchiveSpace(service: SpaceServiceLike, id: string): Promise<Space>;
  /** Delete the Space, releasing (not deleting) its workspace registration. */
  deleteSpace(service: SpaceServiceLike, id: string): Promise<void>;
  /** Best-effort reconciliation of every persisted binding (startup). */
  reconcileAll(): Promise<void>;
}

interface PreparedWorkspace {
  workspaceId: string;
  path: string;
  title: string;
  /** True only when this call created the registration (used for rollback). */
  created: boolean;
  /** Title an adopted workspace had before this operation (rollback restores it). */
  previousTitle?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirectoryString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Build the Space ↔ workspace bridge.
 * @param options - registry, store, logger and test seams.
 * @returns the bridge consumed by the RPC layer and Host activation.
 */
export function createSpaceWorkspaceSync(
  options: SpaceWorkspaceSyncOptions,
): SpaceWorkspaceSync {
  const { registry, store } = options;
  const logger = options.logger ?? {};
  const now = options.now ?? (() => new Date());
  const home = options.homeDirectory ?? homedir();

  function warn(message: string): void {
    try {
      logger.warn?.(
        `[alter-dsh-space] ${message}`,
      );
    } catch {
      // Diagnostics must never break a Space operation.
    }
  }

  function primaryDirectoryOf(space: Space): string | undefined {
    const first = space.directories?.[0];
    return isDirectoryString(first) ? first.trim() : undefined;
  }

  function expandHome(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '~') return home;
    if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2));
    if (!isAbsolute(trimmed)) {
      throw new WorkspaceSyncError(
        'space/workspace-invalid',
        `工作目录必须是本机绝对路径：${raw}`,
      );
    }
    return trimmed;
  }

  async function canonicalDirectory(raw: string): Promise<string> {
    const absolute = expandHome(raw);
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch {
      throw new WorkspaceSyncError(
        'space/workspace-missing',
        `工作目录不存在：${raw}`,
      );
    }
    try {
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new WorkspaceSyncError(
        'space/workspace-invalid',
        `工作目录不是文件夹：${raw}`,
      );
    }
    return canonical;
  }

  function workspaceTitles(excludeIds: readonly string[] = []): Set<string> {
    const excluded = new Set(excludeIds);
    return new Set(
      registry
        .list()
        .filter((workspace) => !excluded.has(workspace.id))
        .map((workspace) => workspace.title),
    );
  }

  /** Keep titles unique: DSH's own rename path enforces uniqueness. */
  function uniqueTitle(base: string, excludeIds: readonly string[] = []): string {
    const taken = workspaceTitles(excludeIds);
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${base}（${suffix}）`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}（${now().getTime()}）`;
  }

  function titleForSpace(
    name: string,
    excludeIds: readonly string[] = [],
  ): string {
    const label = name.trim() === '' ? '空间' : name.trim();
    return uniqueTitle(`${WORKSPACE_TITLE_PREFIX}${label}`, excludeIds);
  }

  function findWorkspaceByPath(canonical: string): WorkspaceEntityLike | undefined {
    return registry.list().find((workspace) => workspace.path === canonical);
  }

  /**
   * Reject a primary directory already claimed by another Space. Archived
   * Spaces keep their claim: unarchiving restores the same binding.
   */
  async function assertPathAvailable(
    spaceId: string | undefined,
    canonical: string,
  ): Promise<void> {
    for (const candidate of store.read().spaces) {
      if (candidate.id === spaceId) continue;
      const link = store.getWorkspaceLink(candidate.id);
      let claimed = link?.path;
      if (claimed === undefined) {
        const raw = primaryDirectoryOf(candidate);
        if (raw !== undefined) {
          try {
            claimed = await canonicalDirectory(raw);
          } catch {
            // A legacy Space whose directory vanished claims nothing.
            claimed = undefined;
          }
        }
      }
      if (claimed === canonical) {
        throw new WorkspaceSyncError(
          'space/workspace-conflict',
          `该目录已是空间「${candidate.name}」的工作目录，请选择其它目录`,
        );
      }
    }
  }

  /** Create the workspace, or adopt the one already owning the directory. */
  async function bindPrimary(
    canonical: string,
    spaceName: string,
    /** A workspace about to be released by the same operation (never collides). */
    releasingId?: string,
  ): Promise<PreparedWorkspace> {
    const existing = findWorkspaceByPath(canonical);
    if (existing !== undefined) {
      // Adopting keeps the workspace id, so its session accounting survives.
      const title = titleForSpace(
        spaceName,
        releasingId === undefined ? [existing.id] : [existing.id, releasingId],
      );
      const previousTitle = existing.title;
      if (existing.title !== title) await existing.setTitle(title);
      return {
        workspaceId: existing.id,
        path: canonical,
        title,
        created: false,
        previousTitle,
      };
    }
    const title = titleForSpace(
      spaceName,
      releasingId === undefined ? [] : [releasingId],
    );
    const entity = await registry.create(canonical, title);
    // `create` is idempotent by canonical path: a concurrent registration can
    // return an existing record whose title still needs the applied name.
    if (entity.title !== title) await entity.setTitle(title);
    return { workspaceId: entity.id, path: canonical, title, created: true };
  }

  /** Undo a workspace created for a Space that was never committed. */
  async function abortPrepared(
    prepared: PreparedWorkspace | undefined,
  ): Promise<void> {
    if (prepared === undefined) return;
    try {
      const entity = registry.get(prepared.workspaceId);
      if (entity === undefined) return;
      if (prepared.created) {
        if (entity.sessionIds.length > 0) return;
        if (entity.title !== prepared.title) return;
        await registry.delete(prepared.workspaceId);
        return;
      }
      // Adoption is reused, never deleted: only undo the title we applied.
      if (prepared.previousTitle === undefined) return;
      if (entity.title !== prepared.title) return;
      await entity.setTitle(prepared.previousTitle);
    } catch (error) {
      warn(`回滚工作区失败：${describeError(error)}`);
    }
  }

  async function persistLink(
    spaceId: string,
    prepared: PreparedWorkspace,
  ): Promise<void> {
    const link: SpaceWorkspaceLink = {
      spaceId,
      workspaceId: prepared.workspaceId,
      path: prepared.path,
      appliedTitle: prepared.title,
      updatedAt: now().toISOString(),
    };
    try {
      await store.setWorkspaceLink(link);
    } catch (error) {
      // The Space itself already exists; losing the sidecar row must not fail
      // the product operation. A later edit or startup reconcile rebinds it.
      warn(`保存空间工作区绑定失败（${spaceId}）：${describeError(error)}`);
    }
  }

  /**
   * Release one binding: drop the sidecar row, keep the DSH workspace, and
   * strip the marker title only while it is still the title we applied.
   */
  async function releaseLink(link: SpaceWorkspaceLink): Promise<void> {
    try {
      await store.deleteWorkspaceLink(link.spaceId);
    } catch (error) {
      warn(`移除空间工作区绑定失败（${link.spaceId}）：${describeError(error)}`);
    }
    const entity = registry.get(link.workspaceId);
    if (entity === undefined) return;
    // A title the user changed by hand is theirs: never overwrite it.
    if (entity.title !== link.appliedTitle) return;
    if (!entity.title.startsWith(WORKSPACE_TITLE_PREFIX)) return;
    const base =
      entity.title.slice(WORKSPACE_TITLE_PREFIX.length).trim() || '工作区';
    const title = uniqueTitle(base, [entity.id]);
    if (title === entity.title) return;
    try {
      await entity.setTitle(title);
    } catch (error) {
      warn(`恢复工作区标题失败（${entity.id}）：${describeError(error)}`);
    }
  }

  async function syncTitle(space: Space, link: SpaceWorkspaceLink): Promise<void> {
    const entity = registry.get(link.workspaceId);
    if (entity === undefined) return; // Deleted in DSH: rename stays Space-only.
    const title = titleForSpace(space.name, [entity.id]);
    if (entity.title === title && link.appliedTitle === title) return;
    try {
      if (entity.title !== title) await entity.setTitle(title);
      await store.setWorkspaceLink({
        ...link,
        appliedTitle: title,
        updatedAt: now().toISOString(),
      });
    } catch (error) {
      warn(`同步工作区标题失败（${space.id}）：${describeError(error)}`);
    }
  }

  /**
   * Bring one Space's binding back in line with reality: release stale links,
   * rebind an existing workspace at the primary directory, and optionally
   * recreate a workspace the user removed in DSH. `recreate` is true only for
   * an explicit Space action (unarchive); startup reconciliation never
   * resurrects a workspace the user deliberately removed. Never throws.
   */
  async function reconcileSpace(
    space: Space,
    options: { recreate: boolean },
  ): Promise<void> {
    try {
      await reconcileSpaceOnce(space, options);
    } catch (error) {
      // Reconciliation is a background repair: it must never fail the Space
      // operation that triggered it.
      warn(`空间「${space.name}」的工作区对账失败：${describeError(error)}`);
    }
  }

  async function reconcileSpaceOnce(
    space: Space,
    options: { recreate: boolean },
  ): Promise<void> {
    const raw = primaryDirectoryOf(space);
    const link = store.getWorkspaceLink(space.id);
    if (raw === undefined) {
      if (link !== undefined) await releaseLink(link);
      return;
    }
    let canonical: string;
    try {
      canonical = await canonicalDirectory(raw);
    } catch (error) {
      // Keep the link: the directory may be on a temporarily unmounted volume.
      warn(`空间「${space.name}」的工作目录暂不可用，跳过工作区对账：${describeError(error)}`);
      return;
    }
    if (link !== undefined) {
      const bound = registry.get(link.workspaceId);
      if (bound !== undefined && bound.path === canonical) {
        // Healthy: keep the current title (the user may have renamed it in DSH).
        return;
      }
      if (bound === undefined && !options.recreate) {
        // Deleted in DSH: keep the sidecar row so a later explicit action can
        // rebind it, but never resurrect it behind the user's back.
        return;
      }
      await releaseLink(link);
    } else if (!options.recreate) {
      return;
    }
    try {
      await assertPathAvailable(space.id, canonical);
      const prepared = await bindPrimary(canonical, space.name);
      await persistLink(space.id, prepared);
    } catch (error) {
      warn(`空间「${space.name}」的工作区对账失败：${describeError(error)}`);
    }
  }

  async function createSpace(
    service: SpaceServiceLike,
    input: NewSpaceInput,
  ): Promise<Space> {
    const record: Record<string, unknown> = isRecord(input) ? input : {};
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const rawDirectories = Array.isArray(record.directories)
      ? record.directories
      : [];
    const directories = rawDirectories.filter(isDirectoryString);
    // Let the business service own the name error, and never create a
    // workspace for a Space that cannot exist.
    if (name === '') return await service.createSpace(input);
    if (directories.length === 0) {
      throw new WorkspaceSyncError(
        'space/workspace-required',
        '新建空间至少需要一个工作目录（将作为 DSH 工作区）',
      );
    }
    const canonical = await canonicalDirectory(directories[0]!);
    await assertPathAvailable(undefined, canonical);
    const prepared = await bindPrimary(canonical, name);
    let space: Space;
    try {
      space = await service.createSpace(input);
    } catch (error) {
      await abortPrepared(prepared);
      throw error;
    }
    await persistLink(space.id, prepared);
    return space;
  }

  async function updateSpace(
    service: SpaceServiceLike,
    id: string,
    patch: SpacePatch,
  ): Promise<Space> {
    const current = await service.getSpace(id);
    if (current === undefined) return await service.updateSpace(id, patch);
    const record: Record<string, unknown> = isRecord(patch) ? patch : {};
    const nextName =
      typeof record.name === 'string' && record.name.trim() !== ''
        ? record.name.trim()
        : current.name;
    const patchDirectories = Array.isArray(record.directories)
      ? record.directories.filter(isDirectoryString)
      : undefined;
    const previousRaw = primaryDirectoryOf(current);
    const previousLink = store.getWorkspaceLink(id);
    const nextRaw =
      patchDirectories === undefined ? previousRaw : patchDirectories[0];
    let primaryChanged = false;
    let nextCanonical: string | undefined;
    if (nextRaw !== previousRaw) {
      if (nextRaw === undefined) {
        primaryChanged = true;
      } else {
        nextCanonical = await canonicalDirectory(nextRaw);
        if (previousRaw === undefined) {
          primaryChanged = true;
        } else {
          let previousCanonical: string | undefined;
          try {
            previousCanonical = await canonicalDirectory(previousRaw);
          } catch {
            previousCanonical = undefined;
          }
          primaryChanged = previousCanonical !== nextCanonical;
        }
      }
    }
    let prepared: PreparedWorkspace | undefined;
    if (primaryChanged && nextCanonical !== undefined) {
      await assertPathAvailable(id, nextCanonical);
      prepared = await bindPrimary(
        nextCanonical,
        nextName,
        previousLink?.workspaceId,
      );
    }
    let next: Space;
    try {
      next = await service.updateSpace(id, patch);
    } catch (error) {
      await abortPrepared(prepared);
      throw error;
    }
    if (primaryChanged) {
      if (previousLink !== undefined) await releaseLink(previousLink);
      if (prepared !== undefined) await persistLink(id, prepared);
    } else {
      const link = store.getWorkspaceLink(id);
      if (link !== undefined) {
        // A workspace deleted in DSH stays deleted until the user acts on the
        // Space's primary directory or unarchives it.
        if (next.name !== current.name) await syncTitle(next, link);
      } else if (primaryDirectoryOf(next) !== undefined) {
        // Legacy Space (created before this plugin managed workspaces): bind
        // on the first edit without failing an otherwise valid update.
        try {
          const canonical = await canonicalDirectory(primaryDirectoryOf(next)!);
          await assertPathAvailable(id, canonical);
          const adopted = await bindPrimary(canonical, next.name);
          await persistLink(id, adopted);
        } catch (error) {
          warn(`空间「${next.name}」补建工作区失败：${describeError(error)}`);
        }
      }
    }
    return next;
  }

  async function unarchiveSpace(
    service: SpaceServiceLike,
    id: string,
  ): Promise<Space> {
    const space = await service.unarchiveSpace(id);
    await reconcileSpace(space, { recreate: true });
    return space;
  }

  async function deleteSpace(
    service: SpaceServiceLike,
    id: string,
  ): Promise<void> {
    const space = await service.getSpace(id);
    await service.deleteSpace(id);
    if (space === undefined) return;
    const link = store.getWorkspaceLink(id);
    if (link !== undefined) await releaseLink(link);
  }

  async function reconcileAll(): Promise<void> {
    const spaces = new Map(store.read().spaces.map((space) => [space.id, space]));
    for (const link of store.listWorkspaceLinks()) {
      const space = spaces.get(link.spaceId);
      if (space === undefined) {
        // Orphan sidecar row (the Space was deleted outside this bridge).
        try {
          await store.deleteWorkspaceLink(link.spaceId);
        } catch (error) {
          warn(`清理孤儿工作区绑定失败（${link.spaceId}）：${describeError(error)}`);
        }
        continue;
      }
      await reconcileSpace(space, { recreate: false });
    }
  }

  return {
    createSpace,
    updateSpace,
    unarchiveSpace,
    deleteSpace,
    reconcileAll,
  };
}
