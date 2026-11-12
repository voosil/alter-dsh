/**
 * Kernel selection: which editor kernel renders a document body.
 *
 * The choice is a UI preference and lives in localStorage — business data never
 * does (the Host is the only authority). It is read once per document page:
 * switching kernels remounts the body, so this is a mount-time decision.
 *
 * The AST-native kernel is the default; `legacy` remains selectable as the
 * rollback path (`{ current: "legacy" }`) until the legacy adapter is retired
 * (`docs/designs/editor-kernel-replacement.md` §6).
 *
 * This module is kernel-neutral on purpose: both the frozen vendor page and the
 * kernels reach it through the same adapter alias, and no kernel imports
 * another.
 *
 * @module @alter-dsh/space/document/editors/kernel-preference
 */
import type { EditorKernelKind } from './kernel';

/** localStorage key holding the preferred kernel. */
export const EDITOR_KERNEL_PREFERENCE_KEY = 'alter-space.editor-kernel';

/** The default kernel: AST-native, with `legacy` kept as the rollback path. */
export const DEFAULT_EDITOR_KERNEL: EditorKernelKind = 'tiptap';

/** Storage shape: `{ current, reviewedAt }` keeps the switch explicit. */
export interface EditorKernelPreference {
  current: EditorKernelKind;
  /**
   * Set by the reviewer once a kernel has been parity-checked. Absent means
   * "never reviewed"; it is recorded for traceability, not used to gate the
   * choice (the default is already the reviewed kernel).
   */
  reviewedAt?: string;
}

/** Parse a stored preference defensively (unknown values fall back). */
export function parseEditorKernelPreference(
  raw: string | null,
): EditorKernelPreference {
  if (raw === null) return { current: DEFAULT_EDITOR_KERNEL };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { current: DEFAULT_EDITOR_KERNEL };
    }
    const record = parsed as Record<string, unknown>;
    const current = record['current'];
    return {
      current:
        current === 'tiptap' || current === 'legacy'
          ? current
          : DEFAULT_EDITOR_KERNEL,
      ...(typeof record['reviewedAt'] === 'string'
        ? { reviewedAt: record['reviewedAt'] }
        : {}),
    };
  } catch {
    return { current: DEFAULT_EDITOR_KERNEL };
  }
}

/** Read the preferred kernel (never throws; storage may be unavailable). */
export function readEditorKernelPreference(): EditorKernelPreference {
  try {
    const storage = globalThis.localStorage as Storage | undefined;
    if (storage === undefined) return { current: DEFAULT_EDITOR_KERNEL };
    return parseEditorKernelPreference(
      storage.getItem(EDITOR_KERNEL_PREFERENCE_KEY),
    );
  } catch {
    return { current: DEFAULT_EDITOR_KERNEL };
  }
}

/** Persist the preferred kernel. */
export function writeEditorKernelPreference(
  preference: EditorKernelPreference,
): void {
  try {
    const storage = globalThis.localStorage as Storage | undefined;
    storage?.setItem(EDITOR_KERNEL_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // A read-only storage must not break the editor.
  }
}