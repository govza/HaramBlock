import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

export interface MessageMeta {
  url: string;
  tabId?: number;
  frameId?: number;
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
