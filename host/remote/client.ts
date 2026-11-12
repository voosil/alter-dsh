/**
 * HTTP client for a self-hosted Space server.
 *
 * The local Host bridge speaks the same Connection envelope the browser
 * speaks, so the server reuses the plugin's RPC dispatcher unchanged. Only
 * authentication (bearer token) and transport error classification are new
 * here.
 *
 * @module @alter-dsh/space/remote/client
 */
import { randomUUID } from 'node:crypto';
import type { SpaceServerInfo } from '../core/protocol.js';

/** RPC channel paths shared with the plugin and server. */
export const REMOTE_RPC_PATH = '/api/alter-space';
export const REMOTE_ASSET_PATH = '/api/alter-space/asset';

/** Transport-level failure while talking to the server. */
export class RemoteClientError extends Error {
  /** Stable machine code; transport failures use `remote/unavailable`. */
  readonly code: string;
  /** HTTP status when a response was received. */
  readonly status: number | undefined;

  constructor(
    code: string,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'RemoteClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map one non-OK HTTP status to the stable remote error code.
 *
 * Only a server that answers with a 5xx is treated as temporarily unavailable
 * (retry later, keep the write queued). A 404/405/400 or any other 4xx means
 * the request or the endpoint is wrong, which retrying cannot fix; that is a
 * protocol/configuration error, not an offline link. 401 stays distinct so the
 * settings surface can ask for a new token.
 */
export function remoteCodeForStatus(status: number): string {
  if (status === 401) return 'remote/unauthorized';
  if (status === 403) return 'remote/unauthorized';
  if (status >= 500) return 'remote/unavailable';
  return 'remote/protocol';
}

/** Human-readable detail for one HTTP failure. */
function statusMessage(status: number): string {
  const code = remoteCodeForStatus(status);
  if (code === 'remote/unauthorized') return '服务端拒绝了 token';
  if (code === 'remote/unavailable')
    return `Space 服务端暂时不可用（HTTP ${String(status)}）`;
  return `Space 服务端协议错误（HTTP ${String(status)}）`;
}

/** Options for one server connection. */
export interface RemoteClientOptions {
  /** Normalized server base URL without trailing slash. */
  baseUrl: string;
  token: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Default request timeout for unary calls. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

function signalWithTimeout(
  timeoutMs: number,
  external: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([timeout, external]);
}

interface RpcEnvelopeResult {
  ok?: unknown;
  value?: unknown;
  error?: unknown;
}

interface RpcEnvelope {
  type?: unknown;
  rpcId?: unknown;
  result?: unknown;
}

/** Business failure returned by the server inside a successful envelope. */
function businessError(value: unknown): never {
  const error =
    typeof value === 'object' && value !== null
      ? (value as { error?: unknown }).error
      : undefined;
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    throw new RemoteClientError(
      (error as { code: string }).code,
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '服务端返回业务错误',
    );
  }
  throw new RemoteClientError('remote/protocol', '服务端返回了无效的业务结果');
}

/**
 * One reusable client bound to a server URL and token.
 */
export class RemoteSpaceClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RemoteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.baseUrl))
      // A saved URL that cannot be spoken to is a configuration problem, not
      // a transient link failure; the mode controller repairs settings for it.
      throw new RemoteClientError(
        'remote/protocol',
        '服务器地址必须使用 http 或 https',
      );
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  }

  /** Authorization headers for every protected request. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers as Record<string, string>),
        signal: signalWithTimeout(this.timeoutMs, signal),
      });
    } catch (error) {
      if (error instanceof RemoteClientError) throw error;
      throw new RemoteClientError(
        'remote/unavailable',
        `无法连接 Space 服务端：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Read the public server identity used for the version handshake. */
  async version(signal?: AbortSignal): Promise<SpaceServerInfo> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/version`, {
        signal: signalWithTimeout(this.timeoutMs, signal),
      });
    } catch (error) {
      throw new RemoteClientError(
        'remote/unavailable',
        `无法连接 Space 服务端：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      const code = remoteCodeForStatus(response.status);
      throw new RemoteClientError(
        code,
        `服务端版本探测失败（HTTP ${String(response.status)}）`,
        response.status,
      );
    }
    let info: Partial<SpaceServerInfo>;
    try {
      info = (await response.json()) as Partial<SpaceServerInfo>;
    } catch {
      // A public /version route that does not answer JSON is not a Space
      // server (proxy page, wrong service); retrying cannot fix it.
      throw new RemoteClientError(
        'remote/protocol',
        '目标地址的 /version 不是合法的 JSON，可能不是 Space 服务端',
        response.status,
      );
    }
    if (
      info.product !== '@alter-dsh/space' ||
      typeof info.protocolVersion !== 'number'
    ) {
      throw new RemoteClientError(
        'remote/protocol',
        '目标地址不是兼容的 Space 服务端',
      );
    }
    return {
      product: info.product,
      version: typeof info.version === 'string' ? info.version : '0.0.0',
      protocolVersion: info.protocolVersion,
      databaseSchemaVersion:
        typeof info.databaseSchemaVersion === 'number'
          ? info.databaseSchemaVersion
          : 0,
    };
  }

  /**
   * Call one RPC endpoint and return the business result (`{ value }` or
   * `{ error }`). Business failures are returned, transport failures throw.
   */
  async rpc(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    void endpoint;
    const rpcId = randomUUID();
    const response = await this.request(
      REMOTE_RPC_PATH,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          payload,
        }),
      },
      signal,
    );
    if (!response.ok) {
      const code = remoteCodeForStatus(response.status);
      throw new RemoteClientError(
        code,
        statusMessage(response.status),
        response.status,
      );
    }
    let envelope: RpcEnvelope;
    try {
      envelope = (await response.json()) as RpcEnvelope;
    } catch {
      // The request may have been applied before the body was mangled (proxy,
      // truncated response). Only this is retryable: a write that errored this
      // way is queued and replayed with its idempotency key, so replaying can
      // never apply it twice. Valid JSON with the wrong shape stays a protocol
      // error below.
      throw new RemoteClientError(
        'remote/unavailable',
        'Space 服务端返回了无法解析的响应，稍后将自动重试',
        response.status,
      );
    }
    if (
      envelope.type !== 'server-response' ||
      envelope.rpcId !== rpcId ||
      typeof envelope.result !== 'object' ||
      envelope.result === null
    ) {
      throw new RemoteClientError('remote/protocol', '服务端响应信封无效');
    }
    const result = envelope.result as RpcEnvelopeResult;
    if (result.ok !== true)
      throw new RemoteClientError('remote/protocol', '服务端响应结果无效');
    return result.value;
  }

  /** Call one endpoint and unwrap the Host's business `{ value }`. */
  async call<T>(
    endpoint: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    void endpoint;
    const result = await this.rpc(endpoint, { op: endpoint, args }, signal);
    if (typeof result === 'object' && result !== null) {
      const record = result as { error?: unknown; value?: unknown };
      if (record.error !== undefined) businessError(result);
      return (record.value ?? undefined) as T;
    }
    return undefined as T;
  }

  /** Fetch one content-addressed asset; callers stream or consume the body. */
  async asset(assetId: string, signal?: AbortSignal): Promise<Response> {
    return this.request(
      `${REMOTE_ASSET_PATH}?id=${encodeURIComponent(assetId)}`,
      { method: 'GET' },
      signal,
    );
  }
}
