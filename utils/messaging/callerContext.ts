import type { ICallerContext } from '@/utils/types';

/**
 * The part of `runtime.MessageSender` that identifies a caller. The browser fills it in for both one-off messages and
 * `runtime.connect` ports; the calling context cannot.
 */
interface CallerSender {
  tab?: { id?: number; incognito?: boolean };
  frameId?: number;
}

export const callerOf = (sender: CallerSender | undefined): ICallerContext => ({
  tabId: sender?.tab?.id,
  frameId: sender?.frameId,
  incognito: sender?.tab?.incognito,
});

let currentContext: ICallerContext = {};

export const setCallerContext = (ctx: ICallerContext) => {
  currentContext = ctx;
};

export const getCallerContext = (): ICallerContext => currentContext;

export const isIncognitoCaller = (caller: ICallerContext = currentContext): boolean => caller.incognito === true;
