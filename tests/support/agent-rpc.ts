/**
 * Agent-facing authority seam for tool tests.
 *
 * The Host routes Agent tools through the alter identity stack; tests must use
 * the same entrance or they would prove something the product never runs. Both
 * helpers below hand back the plain `(endpoint, args) => value` shape the domain
 * tools depend on, with business failures thrown as coded errors.
 */
import { createAgentRpcHandler } from '../../host/authority/rpc.js';
import type {
  ApprovalLike,
  RpcCall,
} from '../../host/authority/tool-support.js';
import type { RemoteBridge } from '../../host/remote/bridge.js';
import type { TestRuntime } from './harness.js';

/** Local runtime → alter-bound endpoint dispatcher (same as the Host builds). */
export function runtimeAgentRpc(runtime: TestRuntime['runtime']): RpcCall {
  return createAgentRpcHandler({
    service: runtime.service,
    agentService: runtime.agentService,
    storage: runtime.storage,
    document: runtime.document,
    agentDocument: runtime.agentDocument,
    assets: runtime.assets,
    workspaceSync: () => undefined,
  });
}

/** Server mode → the bridge's stamped alter port (reads keep the cache path). */
export function bridgeAgentRpc(bridge: RemoteBridge): RpcCall {
  return (endpoint, args) => bridge.agentRpc(endpoint, args);
}

/** Outcome one test approval stub answers with. */
export type ApprovalOutcome =
  | 'allowed-once'
  | 'rejected'
  | 'cancelled'
  | 'unavailable';

/** One recorded approval request. */
export interface ApprovalRequest {
  toolName?: string;
  reason?: string;
}

/** Test double for the DSH approval service. */
export interface ApprovalStub {
  /** Pass as `deps.approval`. */
  approval: () => ApprovalLike;
  /** Every request the tool made, in order. */
  requests: ApprovalRequest[];
}

/**
 * Build an approval double with a fixed outcome.
 * @param outcome - what `request()` answers (defaults to allowing once).
 */
export function approvalStub(
  outcome: ApprovalOutcome = 'allowed-once',
): ApprovalStub {
  const requests: ApprovalRequest[] = [];
  const approval: ApprovalLike = {
    async request(request) {
      requests.push({
        ...(request.toolName === undefined
          ? {}
          : { toolName: request.toolName }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      });
      return outcome;
    },
  };
  return { approval: () => approval, requests };
}