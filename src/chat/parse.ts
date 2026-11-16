/**
 * Space link recognition for conversation references.
 *
 * Two spellings are accepted:
 * - the canonical `dsh-space://space/<spaceId>` and
 *   `dsh-space://space/<spaceId>/page/<nodeId>` forms the Space product copies;
 * - the plugin's in-app router paths `#/space/<spaceId>` and
 *   `#/space/<spaceId>/doc/<nodeId>`, so a link pasted from the address-style
 *   copy action converts as well.
 */

export interface SpaceLinkRef {
  kind: 'space' | 'page';
  spaceId: string;
  nodeId: string | null;
}

const CANONICAL =
  /^dsh-space:\/\/space\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/page\/([A-Za-z0-9][A-Za-z0-9_-]*))?$/;
const ROUTER_PAGE = /^#\/space\/([A-Za-z0-9][A-Za-z0-9_-]*)\/doc\/([A-Za-z0-9][A-Za-z0-9_-]*)$/;
const ROUTER_SPACE = /^#\/space\/([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** Parse one exact link string; anything else is not a Space link. */
export function parseSpaceLink(candidate: string): SpaceLinkRef | null {
  const text = candidate.trim();
  const canonical = CANONICAL.exec(text);
  if (canonical) {
    const [, spaceId, nodeId] = canonical;
    return nodeId
      ? { kind: 'page', spaceId, nodeId }
      : { kind: 'space', spaceId, nodeId: null };
  }
  const page = ROUTER_PAGE.exec(text);
  if (page) return { kind: 'page', spaceId: page[1], nodeId: page[2] };
  const space = ROUTER_SPACE.exec(text);
  if (space) return { kind: 'space', spaceId: space[1], nodeId: null };
  return null;
}

/** Find the first Space link inside a text run, with its span. */
export function findSpaceLink(
  text: string,
  from = 0,
): { ref: SpaceLinkRef; start: number; end: number; raw: string } | null {
  const pattern =
    /dsh-space:\/\/space\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/page\/[A-Za-z0-9][A-Za-z0-9_-]*)?|#\/space\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/doc\/[A-Za-z0-9][A-Za-z0-9_-]*)?/g;
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  if (!match) return null;
  const ref = parseSpaceLink(match[0]);
  return ref
    ? { ref, start: match.index, end: match.index + match[0].length, raw: match[0] }
    : null;
}

/** Canonical link for a space reference. */
export function spaceLink(spaceId: string): string {
  return `dsh-space://space/${spaceId}`;
}

/** Canonical link for a page reference. */
export function pageLink(spaceId: string, nodeId: string): string {
  return `dsh-space://space/${spaceId}/page/${nodeId}`;
}
