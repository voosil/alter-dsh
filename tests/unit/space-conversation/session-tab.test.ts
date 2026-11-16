/**
 * Page-conversation right-sidebar tab: resource addresses, chip titles and the
 * provider's retain/release contract.
 *
 * The tab exists so a page conversation can be read beside its page; the
 * address is the only thing that survives a layout reload, so it gets the same
 * round-trip guarantees the side-chat address has.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_TAB_ADDRESS_PREFIX,
  SESSION_TAB_KIND,
  SESSION_TAB_PATTERN,
  SESSION_TAB_PROTOCOL,
  SESSION_TAB_TYPE_ID,
  buildSessionTabAddress,
  createSessionTabProvider,
  parseSessionTabAddress,
  sessionTabTitle,
} from '../../../src/space-conversation/session-tab';

describe('page-conversation resource address', () => {
  it('round-trips a plain session id', () => {
    const address = buildSessionTabAddress('sess-1');
    expect(address).toBe(`${SESSION_TAB_ADDRESS_PREFIX}sess-1`);
    expect(parseSessionTabAddress(address)).toBe('sess-1');
  });

  it('round-trips an id that needs URI encoding', () => {
    const address = buildSessionTabAddress('a/b c:d');
    expect(address).not.toContain('a/b c:d');
    expect(parseSessionTabAddress(address)).toBe('a/b c:d');
  });

  it('rejects other protocols, hosts and shapes', () => {
    for (const candidate of [
      'dsh-resource://spacechat/session/sess-1',
      'dsh-resource://spacesession/other/sess-1',
      'dsh-resource://spacesession/session/sess-1/extra',
      'dsh-resource://spacesession/session/',
      'sidebar://alter-space.session',
      'not-a-url',
      '#/space/sp-1/doc/doc-1',
    ]) {
      expect(parseSessionTabAddress(candidate), candidate).toBeUndefined();
    }
  });

  it('keeps the constants the registry and opener agree on', () => {
    expect(SESSION_TAB_PROTOCOL).toBe('spacesession');
    expect(SESSION_TAB_PATTERN).toBe(`${SESSION_TAB_ADDRESS_PREFIX}**`);
    expect(SESSION_TAB_KIND).toBe('alter-space.session');
    expect(SESSION_TAB_TYPE_ID).toBe('@alter-dsh/space/session');
    // The body registers under the type id, so the two must stay one string.
    expect(SESSION_TAB_TYPE_ID).toBe('@alter-dsh/space/session');
  });
});

describe('page-conversation chip title', () => {
  it('names the conversation after the session short id', () => {
    expect(sessionTabTitle(buildSessionTabAddress('0123456789abcdef'))).toBe(
      '对话 01234567',
    );
  });

  it('falls back to the generic title for a foreign address', () => {
    expect(sessionTabTitle('dsh-resource://spacechat/session/x')).toBe('对话');
    expect(sessionTabTitle('nonsense')).toBe('对话');
  });
});

describe('page-conversation resource provider', () => {
  it('retains the session while the stream is held and releases on abort', async () => {
    const release = vi.fn();
    const retain = vi.fn(() => ({ sessionId: 'sess-1', release }));
    const provider = createSessionTabProvider({ retain: retain as never });
    expect(provider.protocol).toBe('spacesession');

    const controller = new AbortController();
    const stream = provider.open(buildSessionTabAddress('sess-1'), {
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ ok: true });
    expect(retain).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(release).not.toHaveBeenCalled();

    controller.abort();
    await iterator.next();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reports a failure frame for a malformed address without retaining', async () => {
    const retain = vi.fn();
    const provider = createSessionTabProvider({ retain: retain as never });
    const iterator = provider
      .open('dsh-resource://spacechat/session/x', {
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ ok: false });
    expect(retain).not.toHaveBeenCalled();
  });

  it('reports a failure frame when the session cannot be retained', async () => {
    const provider = createSessionTabProvider({
      retain: (() => {
        throw new Error('no such session');
      }) as never,
    });
    const iterator = provider
      .open(buildSessionTabAddress('gone'), {
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ ok: false });
    expect(JSON.stringify(first.value)).toContain('no such session');
  });
});
