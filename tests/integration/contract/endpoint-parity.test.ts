/**
 * Endpoint contract parity.
 *
 * The RPC surface is declared in three places: the Host whitelist
 * (`host/authority/rpc.ts`), the read/write classification used by the cache
 * and the migration freeze (`host/authority/endpoints.ts`), and the browser
 * mapping (`src/client/rpc.ts` + `src/client/storage.ts`). AGENTS.md requires
 * these to stay in sync; this suite is what enforces it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isReadEndpoint, READ_ENDPOINTS } from '../../../host/authority/endpoints.js';
import {
  DOCUMENT_METHODS,
  HUB_METHODS,
  OBJECT_METHODS,
  RPC_ENDPOINT,
  SPACE_METHODS,
  STORAGE_METHODS,
  isMigrationEndpoint,
  isPluginControlEndpoint,
} from '../../../host/authority/rpc.js';
import { SPACE_RPC_CHANNEL, SPACE_RPC_ENDPOINT } from '../../../src/client/rpc.js';

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const BROWSER_CLIENTS = ['src/client/rpc.ts', 'src/client/storage.ts'];

/** `call('space.x')` / `call<StorageState>('storage.y')` — fully qualified. */
const QUALIFIED_CALL = /(?:call|voidCall)(?:<[^>]*>)?\('([a-zA-Z]+\.[a-zA-Z]+)'/g;
/** `spaceCall('x')` — qualified by its prefix. */
const SPACE_CALL = /spaceCall(?:<[^>]*>)?\('([a-zA-Z]+)'/g;
/** `hubCall('x')` — qualified by its prefix. */
const HUB_CALL = /hubCall(?:<[^>]*>)?\('([a-zA-Z]+)'/g;

/** Control-plane groups served outside the authority whitelist. */
const CONTROL_GROUPS = new Set(['settings', 'sync', 'migration']);

/** Every endpoint the Host accepts from the browser. */
function hostWhitelist(): string[] {
  return [
    ...SPACE_METHODS.map((method) => `space.${method}`),
    ...HUB_METHODS.map((method) => `hub.${method}`),
    ...STORAGE_METHODS.map((method) => `storage.${method}`),
    ...DOCUMENT_METHODS.map((method) => `doc.${method}`),
    ...OBJECT_METHODS.map((method) => `object.${method}`),
  ];
}

/** Endpoint names one browser client module references. */
function browserEndpoints(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(QUALIFIED_CALL)) found.push(match[1]);
  for (const match of source.matchAll(SPACE_CALL)) found.push(`space.${match[1]}`);
  for (const match of source.matchAll(HUB_CALL)) found.push(`hub.${match[1]}`);
  return [...new Set(found)];
}

describe('transport constants', () => {
  it('keeps the channel and endpoint names identical on both sides', () => {
    expect(SPACE_RPC_CHANNEL).toBe('/api');
    expect(SPACE_RPC_ENDPOINT).toBe('alter-space');
    expect(RPC_ENDPOINT).toBe(SPACE_RPC_ENDPOINT);
  });
});

describe('endpoint classification', () => {
  it('only classifies whitelisted endpoints as reads', () => {
    const whitelist = new Set(hostWhitelist());
    for (const endpoint of READ_ENDPOINTS) {
      const group = endpoint.split('.')[0];
      if (CONTROL_GROUPS.has(group)) continue;
      expect(whitelist.has(endpoint), endpoint).toBe(true);
    }
    expect(isReadEndpoint('space.notARealMethod')).toBe(false);
    expect(isReadEndpoint('doc.applyOps')).toBe(false);
  });

  it('routes migration and control-plane endpoints through their own handlers', () => {
    expect(isMigrationEndpoint('migration.start')).toBe(true);
    expect(isMigrationEndpoint('space.createSpace')).toBe(false);
    expect(isPluginControlEndpoint('settings.update')).toBe(true);
    expect(isPluginControlEndpoint('sync.flush')).toBe(true);
    expect(isPluginControlEndpoint('safe.ping')).toBe(false);
  });
});

describe('browser ↔ host endpoint mapping', () => {
  it('maps every endpoint the browser names onto the Host whitelist', async () => {
    const whitelist = new Set([
      ...hostWhitelist(),
      ...['settings.get', 'settings.update', 'settings.test'],
      ...['sync.status', 'sync.flush', 'sync.queue', 'sync.resolve'],
      ...['migration.preflight', 'migration.start', 'migration.status', 'migration.cancel'],
    ]);
    const missing: string[] = [];
    let seen = 0;
    for (const file of BROWSER_CLIENTS) {
      const source = await readFile(join(root, file), 'utf8');
      const endpoints = browserEndpoints(source);
      seen += endpoints.length;
      for (const endpoint of endpoints) {
        if (!whitelist.has(endpoint)) missing.push(`${file}: ${endpoint}`);
      }
    }
    // Guards against this test silently matching nothing after a client refactor.
    expect(seen).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});