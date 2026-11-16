/**
 * Address of one side-chat session resource.
 *
 * A side chat is a DSH session, so its right-sidebar tab is a *resource* tab:
 * the address carries the session id in the tab record's content id. That is
 * what lets a restored sidebar layout reopen the same branch without any
 * navigation parameters (page-kind tabs only keep params from the last open).
 */

/** Resource protocol this plugin serves side-chat session references on. */
export const SIDE_CHAT_PROTOCOL = 'spacechat';

/** Prefix every side-chat address starts with. */
export const SIDE_CHAT_ADDRESS_PREFIX = `dsh-resource://${SIDE_CHAT_PROTOCOL}/session/`;

/** Address whose session segment is empty: a tab whose content was lost. */
export const SIDE_CHAT_ORPHAN_ADDRESS = SIDE_CHAT_ADDRESS_PREFIX;

/** Glob a resource tab type claims side-chat addresses with. */
export const SIDE_CHAT_PATTERN = `${SIDE_CHAT_ADDRESS_PREFIX}**`;

/**
 * Address of one side-chat session resource:
 * `dsh-resource://spacechat/session/<encodeURIComponent(sessionId)>`.
 * @param sessionId - branch session id.
 * @returns the canonical resource address.
 */
export function buildSpaceChatAddress(sessionId: string): string {
  return `${SIDE_CHAT_ADDRESS_PREFIX}${encodeURIComponent(sessionId)}`;
}

/**
 * Parse a side-chat resource address back to its session id.
 * @param address - any address.
 * @returns the session id, or `undefined` for anything else.
 */
export function parseSpaceChatAddress(address: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'dsh-resource:') return undefined;
  if (parsed.hostname.toLowerCase() !== SIDE_CHAT_PROTOCOL) return undefined;
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2 || segments[0] !== 'session') return undefined;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(segments[1]);
  } catch {
    return undefined;
  }
  return sessionId === '' ? undefined : sessionId;
}
