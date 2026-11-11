/**
 * Standalone Space server configuration.
 *
 * The server is deployed by users as a Docker container (or a plain Node
 * process for development). Everything it needs comes from the environment:
 * where the SQLite authority lives, where HTTP listens, and which bearer
 * tokens are accepted.
 *
 * @module @alter-dsh/space/core/config
 */
import { resolve } from 'node:path';

/** One accepted bearer token. */
export interface ServerToken {
  /** Human-readable label used in logs; never the secret itself. */
  label: string;
  /** Bearer secret clients present. */
  token: string;
}

/** Parsed server configuration. */
export interface ServerConfig {
  /** Data directory that owns `space.db`, `assets/` and `backups/`. */
  dataDir: string;
  /** Listen host. */
  host: string;
  /** Listen port. */
  port: number;
  /** Accepted bearer tokens, at least one. */
  tokens: ServerToken[];
  /** Start the daily snapshot scheduler; defaults to `true`. */
  snapshots: boolean;
}

const DEFAULT_DATA_DIR = '/data';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MIN_TOKEN_LENGTH = 16;
/** Obvious placeholder values that must never be accepted as a live token. */
const PLACEHOLDER_TOKEN =
  /(replace[-_ ]?with|change[-_ ]?me|placeholder|example[-_]?token|^todo$)/i;

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`SPACE_PORT 必须是 1–65535 的整数，收到 "${raw}"`);
  return port;
}

/**
 * Parse `SPACE_TOKENS`: comma-separated entries, each `label=token` or a bare
 * `token` (auto-labelled). Duplicate labels or secrets are rejected so an
 * accidental copy-paste cannot produce two interchangeable rows.
 */
export function parseServerTokens(raw: string | undefined): ServerToken[] {
  const source = (raw ?? '').trim();
  if (source === '')
    throw new Error(
      'SPACE_TOKENS 未配置；至少提供一个 token（label=token 或token，逗号分隔）',
    );
  const tokens: ServerToken[] = [];
  const labels = new Set<string>();
  const secrets = new Set<string>();
  for (const [index, entry] of source.split(',').entries()) {
    const item = entry.trim();
    if (item === '') continue;
    const separator = item.indexOf('=');
    const label =
      separator > 0 ? item.slice(0, separator).trim() : `token-${index + 1}`;
    const token =
      separator > 0 ? item.slice(separator + 1).trim() : item;
    if (label === '') throw new Error('SPACE_TOKENS 中存在空的 token 名称');
    if (token === '')
      throw new Error(`SPACE_TOKENS 中 ${label} 的 token 为空`);
    if (token.length < MIN_TOKEN_LENGTH)
      throw new Error(
        `SPACE_TOKENS 中 ${label} 的 token 少于 ${MIN_TOKEN_LENGTH} 个字符`,
      );
    if (PLACEHOLDER_TOKEN.test(token))
      throw new Error(
        `SPACE_TOKENS 中 ${label} 的 token 仍是占位值；请生成随机 token`,
      );
    if (labels.has(label))
      throw new Error(`SPACE_TOKENS 中 token 名称重复：${label}`);
    if (secrets.has(token))
      throw new Error(`SPACE_TOKENS 中 token 重复（名称：${label}）`);
    labels.add(label);
    secrets.add(token);
    tokens.push({ label, token });
  }
  if (tokens.length === 0)
    throw new Error('SPACE_TOKENS 未提供有效 token');
  return tokens;
}

/** Parse a boolean switch that defaults to `true`. */
function readSnapshots(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`SPACE_SNAPSHOTS 必须是布尔值，收到 "${raw}"`);
}

/**
 * Load and validate the server configuration from the environment.
 * @param env - process environment (tests pass a fixture).
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv,
): ServerConfig {
  const dataDir = env.SPACE_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  return {
    dataDir: resolve(dataDir),
    host: env.SPACE_HOST?.trim() || DEFAULT_HOST,
    port: readPort(env.SPACE_PORT),
    tokens: parseServerTokens(env.SPACE_TOKENS),
    snapshots: readSnapshots(env.SPACE_SNAPSHOTS),
  };
}
