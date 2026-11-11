/**
 * Append-only audit trail for connection-setting changes.
 *
 * Writes one JSON line per change (settings page or Agent tool) beside the
 * local Space data directory. Tokens are never recorded: only whether a token
 * was supplied or cleared.
 *
 * @module @alter-dsh/space/control/connection-audit
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** One recorded connection-settings change. */
export interface ConnectionAuditEvent {
  /** Who made the change: `user` (settings page) or `agent`. */
  actor: 'user' | 'agent';
  /** Owning session id for Agent changes, when known. */
  sessionId?: string;
  /** `mode` switches, `server` URL changes, `token` set/clear. */
  action: 'mode' | 'server' | 'token' | 'test' | 'sync';
  /** Previous/next non-secret values. */
  from?: string | null;
  to?: string | null;
  /** Whether this change wrote a token (never the token itself). */
  tokenChanged?: boolean;
  /** `ok` or the failure message. */
  result: 'ok' | 'rejected' | 'failed';
}

/** Writer for one data directory. */
export interface ConnectionAudit {
  record(event: ConnectionAuditEvent): void;
}

/**
 * Open the audit writer. Failures are swallowed: an audit write must never
 * block a legitimate settings change or leak into the user-facing flow.
 * @param directory - local Space data directory.
 */
export function createConnectionAudit(directory: string): ConnectionAudit {
  const file = join(directory, 'connection-audit.jsonl');
  return {
    record(event) {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ...event,
      });
      void (async () => {
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await appendFile(file, `${line}\n`, { mode: 0o600 });
        } catch {
          // Audit is best effort; the change itself already happened.
        }
      })();
    },
  };
}
