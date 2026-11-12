/**
 * Remote transport classification: which HTTP answers mean "retry later" and
 * which mean "the request/protocol is wrong", plus the retryable 200-with-a-
 * mangled-body case.
 */
import { describe, expect, it } from 'vitest';
import {
  RemoteClientError,
  RemoteSpaceClient,
  remoteCodeForStatus,
} from '../../../host/remote/client.js';

function clientWith(fetchImpl: typeof fetch): RemoteSpaceClient {
  return new RemoteSpaceClient({
    baseUrl: 'http://stub.invalid:8787',
    token: 'token',
    fetchImpl,
  });
}

function envelope(rpcId: string, value: unknown): Response {
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

function rpcIdOf(init: RequestInit | undefined): string {
  return (JSON.parse(String(init?.body ?? '{}')) as { rpcId: string }).rpcId;
}

/** One fetch stub that answers every request with `respond`. */
function respondWith(
  respond: (init: RequestInit | undefined) => Response,
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) =>
    respond(init)) as typeof fetch;
}

describe('remote client status classification', () => {
  it('maps HTTP statuses to stable remote error codes', () => {
    expect(remoteCodeForStatus(401)).toBe('remote/unauthorized');
    expect(remoteCodeForStatus(403)).toBe('remote/unauthorized');
    expect(remoteCodeForStatus(500)).toBe('remote/unavailable');
    expect(remoteCodeForStatus(502)).toBe('remote/unavailable');
    expect(remoteCodeForStatus(404)).toBe('remote/protocol');
    expect(remoteCodeForStatus(405)).toBe('remote/protocol');
    expect(remoteCodeForStatus(400)).toBe('remote/protocol');
  });

  it('keeps 401 unauthorized for an RPC call', async () => {
    const client = clientWith(
      respondWith(
        () =>
          new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
          }),
      ),
    );
    await expect(client.call('space.listSpaces', [])).rejects.toMatchObject({
      code: 'remote/unauthorized',
      status: 401,
    });
  });

  it('treats 404 and 405 as protocol errors, not an offline link', async () => {
    for (const status of [404, 405]) {
      const client = clientWith(
        respondWith(
          () => new Response(JSON.stringify({ error: 'bad' }), { status }),
        ),
      );
      await expect(client.call('space.listSpaces', [])).rejects.toMatchObject({
        code: 'remote/protocol',
        status,
      });
    }
  });

  it('treats 5xx as retryable unavailability', async () => {
    const client = clientWith(
      respondWith(
        () => new Response(JSON.stringify({ error: 'boom' }), { status: 502 }),
      ),
    );
    await expect(client.call('doc.applyOps', [])).rejects.toMatchObject({
      code: 'remote/unavailable',
      status: 502,
    });
  });

  it('treats a 200 body that is not JSON as retryable, not protocol', async () => {
    const client = clientWith(
      respondWith(
        () =>
          new Response('<html>proxy error</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    // The request may have been applied before the body broke, so the code
    // must be retryable: the bridge queues the write and replays it with the
    // same idempotency key.
    await expect(client.call('doc.applyOps', [])).rejects.toMatchObject({
      code: 'remote/unavailable',
    });
  });

  it('still rejects a well-formed but wrong envelope as protocol', async () => {
    const client = clientWith(
      respondWith(
        () =>
          new Response(JSON.stringify({ type: 'something-else' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(client.call('space.listSpaces', [])).rejects.toMatchObject({
      code: 'remote/protocol',
    });
  });

  it('returns the business value of a valid envelope', async () => {
    const client = clientWith(
      respondWith((init) =>
        envelope(rpcIdOf(init), { value: [{ id: 'space-1' }] }),
      ),
    );
    await expect(client.call('space.listSpaces', [])).resolves.toEqual([
      { id: 'space-1' },
    ]);
  });

  it('classifies version probe failures by cause', async () => {
    const notFound = clientWith(
      respondWith(() => new Response('not found', { status: 404 })),
    );
    await expect(notFound.version()).rejects.toMatchObject({
      code: 'remote/protocol',
    });

    const broken = clientWith(
      respondWith(() => new Response('oops', { status: 500 })),
    );
    await expect(broken.version()).rejects.toMatchObject({
      code: 'remote/unavailable',
    });

    const html = clientWith(
      respondWith(
        () =>
          new Response('<html>hi</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    await expect(html.version()).rejects.toMatchObject({
      code: 'remote/protocol',
    });
  });

  it('rejects an unsupported base URL as a protocol/configuration error', () => {
    expect(
      () =>
        new RemoteSpaceClient({
          baseUrl: 'ftp://example.com',
          token: 'token',
        }),
    ).toThrow(RemoteClientError);
  });
});