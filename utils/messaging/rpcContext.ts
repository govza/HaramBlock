/**
 * The tab and frame of the caller whose RPC is being handled, so background services can scope state to it, and whether
 * that tab is an incognito tab: the background itself never runs in incognito context, so this is its only source.
 */
export interface RpcContext {
  tabId?: number;
  frameId?: number;
  incognito?: boolean;
}

/**
 * The part of `runtime.MessageSender` that identifies a caller. The browser fills it in for both one-off messages and
 * `runtime.connect` ports; the calling context cannot.
 */
interface CallerSender {
  tab?: { id?: number; incognito?: boolean };
  frameId?: number;
}

export const callerOf = (sender: CallerSender | undefined): RpcContext => ({
  tabId: sender?.tab?.id,
  frameId: sender?.frameId,
  incognito: sender?.tab?.incognito,
});

let currentContext: RpcContext = {};

export const setRpcContext = (ctx: RpcContext) => {
  currentContext = ctx;
};

export const getRpcContext = (): RpcContext => currentContext;

export const isIncognitoCaller = (caller: RpcContext = currentContext): boolean => caller.incognito === true;
