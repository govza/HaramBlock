import type { IRpcContext } from '@/utils/types';

/**
 * The part of `runtime.MessageSender` that identifies a caller. The browser fills it in for both one-off messages and
 * `runtime.connect` ports; the calling context cannot.
 */
interface CallerSender {
  tab?: { id?: number; incognito?: boolean };
  frameId?: number;
}

export const callerOf = (sender: CallerSender | undefined): IRpcContext => ({
  tabId: sender?.tab?.id,
  frameId: sender?.frameId,
  incognito: sender?.tab?.incognito,
});

let currentContext: IRpcContext = {};

export const setRpcContext = (ctx: IRpcContext) => {
  currentContext = ctx;
};

export const getRpcContext = (): IRpcContext => currentContext;

export const isIncognitoCaller = (caller: IRpcContext = currentContext): boolean => caller.incognito === true;
