import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

export interface MessageMeta {
  url: string;
  tabId?: number;
  injector?: 'content' | 'popup';
}

interface MessageSender {
  tab?: { id?: number; url?: string };
  url?: string;
}

export class ProvideAdapter implements Adapter<MessageMeta> {
  sendMessage: SendMessage<MessageMeta> = async message => {
    switch (message.meta?.injector) {
      case 'content': {
        if (message.meta.tabId) {
          await browser.tabs.sendMessage(message.meta.tabId, message);
        } else if (message.meta.url) {
          const tabs = await browser.tabs.query({ url: message.meta.url });
          const tabIds = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
          await Promise.all(tabIds.map(tabId => browser.tabs.sendMessage(tabId, message)));
        }
        break;
      }
      case 'popup': {
        await browser.runtime.sendMessage(message).catch((error: Error) => {
          if (error.message?.includes('Receiving end does not exist')) {
            return;
          }
          throw error;
        });
        break;
      }
      default: {
        await browser.runtime.sendMessage(message).catch((error: Error) => {
          if (error.message?.includes('Receiving end does not exist')) {
            return;
          }
          throw error;
        });
      }
    }
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    const handler = (message: Partial<Message<MessageMeta>> | undefined, sender: MessageSender) => {
      const enrichedMessage = message
        ? {
            ...message,
            meta: {
              ...message.meta,
              tabId: sender.tab?.id,
              url: sender.tab?.url || sender.url || '',
            } as MessageMeta,
          }
        : message;
      callback(enrichedMessage);
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  };
}

export class InjectAdapter implements Adapter<MessageMeta> {
  injector?: 'content' | 'popup';

  constructor(injector?: 'content' | 'popup') {
    this.injector = injector;
  }

  sendMessage: SendMessage<MessageMeta> = message => {
    void browser.runtime.sendMessage(browser.runtime.id, {
      ...message,
      meta: { ...message.meta, url: document.location.href, injector: this.injector },
    });
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    const handler = (message?: Partial<Message<MessageMeta>>) => {
      callback(message);
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  };
}
