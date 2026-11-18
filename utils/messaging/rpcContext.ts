/**
 * The tab and frame of the caller whose RPC is being handled, so background services can scope state to it, and whether
 * that tab is an incognito tab: the background itself never runs in incognito context, so this is its only source.
 */
export interface RpcContext {
  tabId?: number;
  frameId?: number;
  incognito?: boolean;
}

let currentContext: RpcContext = {};

export const setRpcContext = (ctx: RpcContext) => {
  currentContext = ctx;
};

export const getRpcContext = (): RpcContext => currentContext;

export const isIncognitoCaller = (): boolean => currentContext.incognito === true;
