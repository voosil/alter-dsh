/**
 * Registration of a right-Sidebar tab body (a keyed `sidebar.right.pane.tab`
 * occupant).
 *
 * The seat dispatches a tab's body by the tab type's `id`, so a missing body
 * shows DSH's 「这类内容还没有可用的查看方式」 notice even though the type and
 * its guide box exist. Two things make a plain `register` fragile here:
 *
 * - the slot lives inside the right column's Session subtree, so it may only
 *   become declared later than plugin apply (hence `slots.inject`);
 * - a plugin reload can leave the *type* registered from an earlier module
 *   instance, and a second `tabs.register` for the same id then throws before
 *   the body is reached (`registerTabType` handles that half).
 *
 * The body itself registers through `slots.inject`, which waits for the seat's
 * declaration and re-runs when it is re-declared.
 */
import type { ComponentType } from 'react';

/** Minimal slot-service face this helper needs. */
export interface SlotsFace {
  register(
    options: {
      name: string;
      key: string;
      children?: Record<string, { kind: string; scope: string }>;
    },
    component: ComponentType<never>,
  ): () => void;
  inject(key: string, callback: () => () => void): () => void;
}

/** Minimal tab-type registry face this helper needs. */
export interface TabTypesFace {
  register(definition: {
    id: string;
    kind: string;
    title: (address: string) => string;
    [field: string]: unknown;
  }): () => void;
}

/**
 * Register a tab type, tolerating an id the registry already holds.
 *
 * A client module reload can leave the previous instance's type registration in
 * place while its body registration is gone; `register` then throws on the
 * duplicate id and the caller never reaches its body. The type already answers
 * for the kind in that case, so this reports "nothing to dispose" and lets the
 * caller register the body, which is what the seat actually dispatches.
 * @param tabs - the tab-type registry.
 * @param definition - the type definition.
 * @param logger - optional diagnostic sink.
 * @returns a disposer for this registration (a no-op when it was already there).
 */
export function registerTabType(
  tabs: TabTypesFace,
  definition: {
    id: string;
    kind: string;
    title: (address: string) => string;
    [field: string]: unknown;
  },
  logger?: TabBodyContext['logger'],
): () => void {
  try {
    return tabs.register(definition);
  } catch (error) {
    logger?.warn?.(
      `[alter-space] tab type ${definition.id} was already registered; keeping it and registering the body`,
      error,
    );
    return () => {};
  }
}

/** Minimal context face this helper needs. */
export interface TabBodyContext {
  readonly slots: SlotsFace;
  /** Optional diagnostic sink; a failed attempt is not fatal. */
  readonly logger?: {
    warn?(message: string, ...rest: unknown[]): void;
  };
}

/**
 * Register one tab body under the tab type's id.
 * @param ctx - context carrying the slot service.
 * @param slotName - the seat slot (`sidebar.right.pane.tab`).
 * @param key - the tab type id.
 * @param component - the body component.
 * @returns a disposer that removes both attempts.
 */
export function registerTabBody(
  ctx: TabBodyContext,
  slotName: string,
  key: string,
  component: ComponentType<never>,
  children?: Record<string, { kind: string; scope: string }>,
): () => void {
  const disposeInject = ctx.slots.inject(slotName, () => {
    try {
      return ctx.slots.register(
        children === undefined
          ? { name: slotName, key }
          : { name: slotName, key, children },
        component,
      );
    } catch (error) {
      ctx.logger?.warn?.(
        `[alter-space] ${key} body registration failed`,
        error,
      );
      return () => {};
    }
  });
  return () => {
    try {
      disposeInject();
    } catch {
      // A registration already gone is not an error.
    }
  };
}

/** Context face for one resource-provider registration. */
export interface ResourcesFace {
  register(provider: unknown): () => void;
  readonly [field: string]: unknown;
}

/** Context face the provider helper needs. */
export interface ResourceContext {
  readonly resources: ResourcesFace;
  readonly logger?: {
    warn?(message: string, ...rest: unknown[]): void;
  };
}

/**
 * Register a tab type's resource provider, tolerating a duplicate.
 *
 * Like the type registry, the resource protocol can still hold the previous
 * module instance's provider; a refused duplicate must not stop the tab body
 * from registering, because the body is what the seat dispatches.
 * @param ctx - context carrying the resource service.
 * @param create - builds the provider.
 * @returns a disposer (a no-op when the provider was already there).
 */
export function safeRegisterResource(
  ctx: ResourceContext,
  create: () => unknown,
): () => void {
  try {
    return ctx.resources.register(create());
  } catch (error) {
    ctx.logger?.warn?.(
      '[alter-space] resource provider was already registered; keeping it',
      error,
    );
    return () => {};
  }
}
