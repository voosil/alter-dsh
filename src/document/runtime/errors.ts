/**
 * Structured diagnostics for the restored document UI.
 *
 * The legacy documents view catches failures in many places (mount/parse,
 * saves, conflicts, restores, creation, comments, render boundaries). This
 * module is the single reporting seam: it turns any thrown value into one
 * structured record and logs it with `console.error` so a failing client leaves
 * a reproducible trace.
 *
 * Privacy: the report only carries a fixed set of identifiers (document,
 * block, comment, revision, scope). Document body text is never logged — the
 * context object is filtered through a whitelist, so callers cannot leak
 * content by accident.
 *
 * @module @alter-dsh/space/document/runtime/errors
 */

/** Coarse operation a failure came from. */
export type DocumentErrorScope =
  | 'load'
  | 'save'
  | 'conflict'
  | 'restore'
  | 'create'
  | 'comments'
  | 'anchor'
  | 'asset'
  | 'render';

/** Identifier fields allowed in a report (never document body text). */
export interface DocumentErrorContext {
  docId?: string;
  revision?: number;
  baseRevision?: number;
  serverRevision?: number;
  blockId?: string;
  commentId?: string;
  operation?: string;
}

/** One structured record emitted for a document-UI failure. */
export interface DocumentErrorReport extends DocumentErrorContext {
  scope: DocumentErrorScope;
  /** Stable machine code when the thrown value carries one (`doc/conflict`…). */
  code?: string;
  message: string;
  /** Stack of the original error, for development diagnostics. */
  stack?: string;
}

/** Prefix used for every console entry (easy to filter in dev tools). */
export const DOCUMENT_ERROR_LOG_PREFIX = '[alter-space:document]';

const SAFE_CONTEXT_KEYS = [
  'docId',
  'revision',
  'baseRevision',
  'serverRevision',
  'blockId',
  'commentId',
  'operation',
] as const satisfies ReadonlyArray<keyof DocumentErrorContext>;

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  if (typeof error === 'string' && error !== '') return error;
  return '未知错误';
}

function safeContext(
  context: Readonly<Record<string, unknown>>,
): DocumentErrorContext {
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_CONTEXT_KEYS) {
    const value = context[key];
    if (typeof value === 'string' || typeof value === 'number') {
      safe[key] = value;
    }
  }
  return safe as DocumentErrorContext;
}

/**
 * Report one document-UI failure.
 *
 * Logs a structured, content-free record through `console.error` and returns
 * it (useful for tests/telemetry adapters). Never throws.
 *
 * @param scope - operation that failed (`load`/`save`/`conflict`/…).
 * @param error - thrown value (any shape).
 * @param context - optional identifiers; unknown keys are dropped so document
 *   text can never reach the log.
 */
export function reportDocumentError(
  scope: DocumentErrorScope,
  error: unknown,
  context: Readonly<Record<string, unknown>> = {},
): DocumentErrorReport {
  const report: DocumentErrorReport = {
    scope,
    ...safeContext(context),
    ...(errorCodeOf(error) === undefined ? {} : { code: errorCodeOf(error) }),
    message: errorMessageOf(error),
    ...(error instanceof Error && typeof error.stack === 'string'
      ? { stack: error.stack }
      : {}),
  };
  try {
    console.error(DOCUMENT_ERROR_LOG_PREFIX, report);
  } catch {
    // Diagnostics must never surface as a second failure.
  }
  return report;
}
