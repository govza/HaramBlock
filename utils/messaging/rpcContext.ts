export interface RpcContext {
  tabId?: number;
  frameId?: number;
}

let currentContext: RpcContext = {};

export const setRpcContext = (ctx: RpcContext) => {
  currentContext = ctx;
};

export const getRpcContext = (): RpcContext => currentContext;
