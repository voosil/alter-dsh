/**
 * Registration ownership of the reference surfaces.
 *
 * The sent-message cards and the composer half are two registrations on the
 * same conversation: the cards own the `space-ref` user-text rule plus its node
 * renderer, the composer owns the dock id `alter-space-refs` and the `@space-ref`
 * trigger source. DSH throws on a duplicate declaration and on a duplicate
 * trigger source, so a registration that owned both halves twice would leave the
 * surviving composer without a codec — every chip would silently degrade to
 * plain text. These cases pin the split.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatStore } from '../../../src/chat/store';
import { registerSpaceRefCards } from '../../../src/space-conversation/register-cards';
import {
  SPACE_REF_DOCK_ID,
  SPACE_REF_INSERT_EVENT,
  insertSpaceRefChip,
  registerSpaceRefComposer,
  spaceRefInsert,
  type SpaceRefComposerContext,
} from '../../../src/space-conversation/refs';

/** A slot registry double that rejects duplicate (name, id) declarations. */
function slotDouble() {
  const declared = new Map<string, () => void>();
  const registered: string[] = [];
  const slots = {
    inject(_key: string, callback: () => () => void) {
      callback();
    },
    register(options: Record<string, unknown>) {
      const key = `${String(options.name)}#${String(options.key ?? options.id)}`;
      if (declared.has(key)) throw new Error(`duplicate declaration ${key}`);
      registered.push(key);
      const dispose = () => declared.delete(key);
      declared.set(key, dispose);
      return dispose;
    },
  };
  return { slots, declared, registered };
}

/** A trigger registry double that rejects duplicate (trigger, name) pairs. */
function triggersDouble() {
  const sources = new Map<string, unknown>();
  return {
    sources,
    inputTriggers: {
      registerSource(source: { trigger: string; name: string }) {
        const key = `${source.trigger}${source.name}`;
        if (sources.has(key)) throw new Error(`slash source "${key}" is already registered`);
        sources.set(key, source);
        return () => sources.delete(key);
      },
    },
  };
}

/** Declarations on the composer's dock slot (the card renderer has its own). */
function dockDeclarations(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith('conversation.input.dock#'));
}

/** Session scope the chip insertion dispatches through. */
const scoped = { bail: vi.fn(() => true) };

/** Context carrying every face both registrations touch. */
function context() {
  const { slots, declared, registered } = slotDouble();
  const { sources, inputTriggers } = triggersDouble();
  const ctx = {
    slots,
    sessions: { scope: () => scoped },
    get: (name: string) => (name === 'inputTriggers' ? inputTriggers : undefined),
    uiConversation: { userText: { register: () => () => undefined } },
  };
  return { ctx, declared, registered, sources };
}

const STORE = {} as unknown as ChatStore;
const PAGE = { kind: 'page' as const, spaceId: 'alpha', nodeId: 'n-01' };

afterEach(() => {
  vi.clearAllMocks();
});

describe('reference surface ownership', () => {
  it('registers the dock and the trigger source exactly once across both halves', () => {
    const { ctx, registered, sources } = context();
    const disposeCards = registerSpaceRefCards(ctx);
    const disposeComposer = registerSpaceRefComposer({
      ctx: ctx as unknown as SpaceRefComposerContext,
      store: STORE,
    });
    try {
      // One dock contribution, one codec source: no duplicate declaration to
      // throw on, so the composer keeps its codec.
      expect(dockDeclarations(registered)).toEqual([`conversation.input.dock#${SPACE_REF_DOCK_ID}`]);
      expect([...sources.keys()]).toEqual(['@space-ref']);
      // The surviving composer can insert chips — the visible half of owning
      // the codec exactly once.
      expect(
        insertSpaceRefChip('s1', spaceRefInsert(PAGE), { start: 0, end: 1, draftRev: 1 }),
      ).toBe(true);
      expect(scoped.bail).toHaveBeenCalledWith(
        scoped,
        SPACE_REF_INSERT_EVENT,
        expect.objectContaining({ reference: spaceRefInsert(PAGE) }),
      );
    } finally {
      disposeComposer();
      disposeCards();
    }
  });

  it('registers no dock and no trigger source when only the cards are wired', () => {
    const { ctx, registered, sources } = context();
    const dispose = registerSpaceRefCards(ctx);
    try {
      // The card renderer rides its own slot; the dock and codec do not.
      expect(dockDeclarations(registered)).toEqual([]);
      expect(sources.size).toBe(0);
    } finally {
      dispose();
    }
  });

  it('tears the dock and the codec down with the composer', () => {
    const { ctx, declared, sources } = context();
    const disposeCards = registerSpaceRefCards(ctx);
    const disposeComposer = registerSpaceRefComposer({
      ctx: ctx as unknown as SpaceRefComposerContext,
      store: STORE,
    });
    expect(dockDeclarations([...declared.keys()])).toHaveLength(1);
    expect(sources.size).toBe(1);
    disposeComposer();
    disposeCards();
    expect(dockDeclarations([...declared.keys()])).toEqual([]);
    expect(sources.size).toBe(0);
    // Without the codec no chip may enter a draft: sending would fail.
    expect(
      insertSpaceRefChip('s1', spaceRefInsert(PAGE), { start: 0, end: 1, draftRev: 1 }),
    ).toBe(false);
  });
});
