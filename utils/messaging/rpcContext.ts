/**
 * The tab and frame of the caller whose RPC is being handled, so background services can scope state to it.
 */
export interface RpcContext {
  tabId?: number;
  frameId?: number;
}

let currentContext: RpcContext = {};

export const setRpcContext = (ctx: RpcContext) => {
  currentContext = ctx;
};

export const getRpcContext = (): RpcContext => currentContext;
