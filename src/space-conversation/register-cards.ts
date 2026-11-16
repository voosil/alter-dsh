/**
 * Conversation-side registration of the Space reference cards.
 *
 * Owns the two sent-message contributions: the synchronous `space-ref`
 * user-text rule and the keyed card renderer. The *composer* half (in-draft
 * chips + the reference strip above the input) is a separate surface with its
 * own dependencies and is registered by the assembly through
 * `registerSpaceRefComposer`. Owning it here as well would declare the same
 * dock id (`alter-space-refs`) and the same trigger source (`@space-ref`) a
 * second time — DSH rejects both duplicates, and the failed composer would then
 * have no codec, silently degrading every chip to plain text.
 *
 * The context face mirrors `src/integration/dsh.ts` plus the conversation
 * UserText service, so the bundle never imports `@deepseek-ai/*` at runtime.
 */
import type { SpaceClientContext } from '../integration/dsh';
import {
  SPACE_REF_ID,
  SPACE_REF_PRIORITY,
  SPACE_REF_SLOT,
  SpaceRefCard,
  spaceRefRule,
  type SpaceRefRule,
} from './cards';

/** Client context face `registerSpaceRefCards` needs. */
export interface SpaceRefCardsContext {
  readonly slots: SpaceClientContext['slots'];
  readonly uiConversation: {
    userText: {
      register(rule: SpaceRefRule): () => void;
    };
  };
}

/**
 * Register the Space reference cards on the conversation factory.
 * @param ctx - client context carrying the conversation UserText service and the slots.
 * @returns cleanup that tears the node renderer down, then the rule.
 */
export function registerSpaceRefCards(ctx: SpaceRefCardsContext): () => void {
  const disposeRule = ctx.uiConversation.userText.register(spaceRefRule);
  // The slot contribution is owned by the slots service; the cleanup below
  // only disposes the latest mount as a best-effort teardown companion.
  let disposeRenderer: (() => void) | null = null;
  ctx.slots.inject(SPACE_REF_SLOT, () => {
    const dispose = ctx.slots.register(
      { name: SPACE_REF_SLOT, key: SPACE_REF_ID, priority: SPACE_REF_PRIORITY },
      SpaceRefCard,
    );
    disposeRenderer = dispose;
    return dispose;
  });
  return () => {
    disposeRule();
    disposeRenderer?.();
  };
}
