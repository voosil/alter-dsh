export const PROTOCOL_VERSION = 1 as const;

export interface RuntimeStatus {
  protocolVersion: typeof PROTOCOL_VERSION;
  product: 'Alter';
  runtime: 'dsh';
  ready: boolean;
  toolCount: number;
}

export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('protocolVersion' in value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !('product' in value) ||
    value.product !== 'Alter' ||
    !('runtime' in value) ||
    value.runtime !== 'dsh' ||
    !('ready' in value) ||
    typeof value.ready !== 'boolean' ||
    !('toolCount' in value) ||
    typeof value.toolCount !== 'number' ||
    !Number.isSafeInteger(value.toolCount) ||
    value.toolCount < 0
  )
    throw new Error('不兼容的 Alter 服务响应');
  return value as RuntimeStatus;
}

export type {
  TerminalOpen,
  TerminalSession,
  TerminalOutput,
  TerminalService,
} from './terminal.js';

export type * from './space.js';
export type * from './space-hub.js';
