/**
 * Bearer-token authentication for the standalone Space server.
 *
 * The server is single-user and self-hosted: named tokens let a user give each
 * device its own secret and revoke one device without rotating the others.
 * Comparison is constant-time over SHA-256 digests so token length does not
 * leak through timing.
 *
 * @module @alter-dsh/space/server/auth
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerToken } from './config.js';

/** One registered token with its pre-computed digest. */
interface RegisteredToken {
  label: string;
  digest: Buffer;
}

/** Verifier for one server's accepted tokens. */
export interface TokenAuthenticator {
  /** Number of accepted tokens (labels are safe to log). */
  readonly count: number;
  /** Token labels, safe to log. */
  readonly labels: readonly string[];
  /** Whether the request's `Authorization` header names an accepted token. */
  authorize(header: string | undefined): boolean;
}

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Build the verifier for the configured tokens.
 * @param tokens - non-empty accepted token list from configuration.
 */
export function createTokenAuthenticator(
  tokens: readonly ServerToken[],
): TokenAuthenticator {
  if (tokens.length === 0) throw new Error('至少需要一个服务端 token');
  const registered: RegisteredToken[] = tokens.map(({ label, token }) => ({
    label,
    digest: digestOf(token),
  }));
  return {
    count: registered.length,
    labels: registered.map((entry) => entry.label),
    authorize(header: string | undefined): boolean {
      if (header === undefined) return false;
      const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
      if (match === null) return false;
      const candidate = digestOf(match[1]);
      let accepted = false;
      for (const entry of registered) {
        // Evaluate every row so a match's position does not change timing.
        if (timingSafeEqual(candidate, entry.digest)) accepted = true;
      }
      return accepted;
    },
  };
}
