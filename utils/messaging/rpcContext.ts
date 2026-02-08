export interface RpcContext {
  tabId?: number;
}

let currentContext: RpcContext = {};

export const setRpcContext = (ctx: RpcContext) => {
  currentContext = ctx;
};

export const getRpcContext = (): RpcContext => currentContext;
