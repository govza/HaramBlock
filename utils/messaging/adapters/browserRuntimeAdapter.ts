import type { ICallerContext } from '@/utils/types';
import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

/**
 * Routing metadata comctx carries with each message, telling the background which context to answer. The background
 * stamps `caller` from the browser-provided sender; a value sent by the calling context is overwritten.
 */
export interface MessageMeta {
  url: string;
  caller?: ICallerContext;
  injector?: 'content' | 'popup';
}

export class InjectAdapter implements Adapter<MessageMeta> {
  injector?: 'content' | 'popup';

  constructor(injector?: 'content' | 'popup') {
    this.injector = injector;
  }

  sendMessage: SendMessage<MessageMeta> = message => {
    try {
      void browser.runtime
        .sendMessage(browser.runtime.id, {
          ...message,
          meta: { ...message.meta, url: self.location.href, injector: this.injector },
        })
        .catch(() => {});
    } catch {
      // Extension context invalidated (e.g. after extension reload)
    }
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    const handler = (message?: Partial<Message<MessageMeta>>) => {
      callback(message);
    };
    try {
      browser.runtime.onMessage.addListener(handler);
    } catch {
      return () => {};
    }
    return () => {
      try {
        browser.runtime.onMessage.removeListener(handler);
      } catch {
        // Extension context invalidated
      }
    };
  };
}
