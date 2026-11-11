/**
 * Standalone server carrier: configuration, authentication, health/version and
 * the authenticated RPC/asset routes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalSpaceRuntime, type LocalSpaceRuntime } from '../../../host/core/runtime.js';
import { createTokenAuthenticator } from '../../../server/core/auth.js';
import {
  loadServerConfig,
  parseServerTokens,
  type ServerToken,
} from '../../../server/core/config.js';
import {
  createSpaceHttpServer,
  type SpaceHttpServer,
} from '../../../server/core/http.js';

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'fedcba9876543210fedcba9876543210';

interface Fixture {
  directory: string;
  runtime: LocalSpaceRuntime;
  http: SpaceHttpServer;
  baseUrl: string;
  tokens: ServerToken[];
}

let fixture: Fixture | undefined;

async function startFixture(options: {
  tokens?: string;
  maxRequestBodyBytes?: number;
} = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'space-server-'));
  const tokens = parseServerTokens(
    options.tokens ?? `test=${VALID_TOKEN}`,
  );
  const runtime = await createLocalSpaceRuntime({
    directory,
    snapshots: false,
  });
  const http = createSpaceHttpServer({
    runtime,
    auth: createTokenAuthenticator(tokens),
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
  const port = await http.listen('127.0.0.1', 0);
  return {
    directory,
    runtime,
    http,
    tokens,
    baseUrl: `http://127.0.0.1:${String(port)}`,
  };
}

function rpcBody(op: string, args: unknown[] = []): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc-test-1',
    payload: { op, args },
  });
}

async function postRpc(
  baseUrl: string,
  body: string,
  token: string | null = VALID_TOKEN,
): Promise<Response> {
  return fetch(`${baseUrl}/api/alter-space`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
  });
}

beforeEach(async () => {
  fixture = await startFixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current === undefined) return;
  await current.http.close();
  await current.runtime.close();
  await rm(current.directory, { recursive: true, force: true });
});

describe('server configuration', () => {
  it('parses named and bare tokens', () => {
    const tokens = parseServerTokens(
      `laptop=${VALID_TOKEN}, ${OTHER_TOKEN}`,
    );
    expect(tokens.map((entry) => entry.label)).toEqual([
      'laptop',
      'token-2',
    ]);
  });

  it('rejects missing, short and duplicate tokens', () => {
    expect(() => parseServerTokens(undefined)).toThrow(/SPACE_TOKENS/);
    expect(() => parseServerTokens('short')).toThrow(/少于 16 个字符/);
    expect(() =>
      parseServerTokens(`a=${VALID_TOKEN},b=${VALID_TOKEN}`),
    ).toThrow(/重复/);
  });

  it('loads defaults and validates the port', () => {
    const config = loadServerConfig({ SPACE_TOKENS: VALID_TOKEN });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    // The container default is the absolute path `/data`; resolve() anchors it
    // against the platform root, so compare with the resolved form.
    expect(config.dataDir).toBe(resolve('/data'));
    expect(config.snapshots).toBe(true);
    expect(() =>
      loadServerConfig({ SPACE_TOKENS: VALID_TOKEN, SPACE_PORT: 'abc' }),
    ).toThrow(/SPACE_PORT/);
  });
});

describe('server authentication', () => {
  it('accepts a configured token and rejects another', () => {
    const auth = createTokenAuthenticator(
      parseServerTokens(`a=${VALID_TOKEN}`),
    );
    expect(auth.authorize(`Bearer ${VALID_TOKEN}`)).toBe(true);
    expect(auth.authorize(`Bearer ${OTHER_TOKEN}`)).toBe(false);
    expect(auth.authorize('Basic abc')).toBe(false);
    expect(auth.authorize(undefined)).toBe(false);
  });
});

describe('server HTTP routes', () => {
  it('serves public health and version facts', async () => {
    const current = fixture as Fixture;
    const health = await fetch(`${current.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody.ok).toBe(true);
    expect(healthBody.product).toBe('@alter-dsh/space');
    expect(healthBody.protocolVersion).toBe(1);

    const version = await fetch(`${current.baseUrl}/version`);
    expect(version.status).toBe(200);
    const versionBody = (await version.json()) as Record<string, unknown>;
    expect(versionBody.databaseSchemaVersion).toBeGreaterThanOrEqual(3);
  });

  it('rejects unauthenticated RPC and assets with 401', async () => {
    const current = fixture as Fixture;
    const rpc = await postRpc(
      current.baseUrl,
      rpcBody('space.listSpaces'),
      null,
    );
    expect(rpc.status).toBe(401);
    const asset = await fetch(
      `${current.baseUrl}/api/alter-space/asset?id=missing`,
    );
    expect(asset.status).toBe(401);
    const wrong = await postRpc(
      current.baseUrl,
      rpcBody('space.listSpaces'),
      OTHER_TOKEN,
    );
    expect(wrong.status).toBe(401);
  });

  it('dispatches an authenticated RPC envelope', async () => {
    const current = fixture as Fixture;
    const response = await postRpc(
      current.baseUrl,
      rpcBody('space.listSpaces'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      rpcId: string;
      result: { ok: boolean; value: { value: unknown } };
    };
    expect(body.type).toBe('server-response');
    expect(body.rpcId).toBe('rpc-test-1');
    expect(body.result.ok).toBe(true);
    const spaces = body.result.value.value as Array<{ name: string }>;
    expect(spaces.map((space) => space.name)).toContain('日常');
  });

  it('serves a content-addressed asset through the authenticated route', async () => {
    const current = fixture as Fixture;
    // Import a tiny PNG through the same RPC surface a browser uses.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=',
      'base64',
    );
    const imported = await postRpc(
      current.baseUrl,
      rpcBody('doc.importAsset', [
        { mime: 'image/png', dataBase64: png.toString('base64') },
      ]),
    );
    const importBody = (await imported.json()) as {
      result: { value: { value: { assetId: string } } };
    };
    const assetId = importBody.result.value.value.assetId;
    expect(assetId).toMatch(/^asset_/);
    const asset = await fetch(
      `${current.baseUrl}/api/alter-space/asset?id=${encodeURIComponent(assetId)}`,
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await asset.arrayBuffer());
    expect(bytes.equals(png)).toBe(true);
  });

  it('answers 404/405 without leaking route internals', async () => {
    const current = fixture as Fixture;
    expect((await fetch(`${current.baseUrl}/nope`)).status).toBe(404);
    const wrongMethod = await fetch(`${current.baseUrl}/api/alter-space`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(wrongMethod.status).toBe(405);
  });

  it('rejects an over-limit RPC body with 413', async () => {
    const current = await startFixture({ maxRequestBodyBytes: 32 });
    try {
      const response = await postRpc(
        current.baseUrl,
        rpcBody('space.listSpaces'),
      );
      expect(response.status).toBe(413);
    } finally {
      await current.http.close();
      await current.runtime.close();
      await rm(current.directory, { recursive: true, force: true });
    }
  });
});
