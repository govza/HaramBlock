import { logger } from '@/utils/logger';
import { isChannelRequest } from '@/utils/messaging/channel';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type {
  ChannelReady,
  ChannelRequest,
  ChannelResponse,
  IImageWithBitmap,
  ProcessImageAction,
} from '@/utils/types';

/**
 * Handles establishing a direct messageChannelController tunnel from content via an injected
 * web-accessible page to the background service worker.
 *
 * Iframe script posts: `{ type: 'PORT_READY', secret }` with a transferred MessagePort.
 * We ACK immediately so the content side resolves its readiness await.
 */
export class MessageChannelController {
  private readonly ports = new Map<string, MessagePort>();

  constructor(
    private readonly hostSettingsService: HostSettingsService,
    private readonly orchestrationService: InferenceOrchestrationService,
  ) {}

  public initialize(): void {
    // Listen for messages sent to the service worker global (from the injected page)
    globalThis.addEventListener('message', this.handleMessageEventAdapter);
  }

  private handleMessageEventAdapter = (evt: Event): void => {
    this.handleMessageEvent(evt as MessageEvent);
  };

  private handleMessageEvent = (evt: MessageEvent): void => {
    const data = (evt as MessageEvent & { data?: unknown; ports?: MessagePort[] }).data as
      | { type?: string; secret?: string }
      | undefined;
    if (!data || !('type' in data)) return;

    if (data.type === 'PORT_READY') {
      const secret = data.secret || '';
      const ports = (evt as MessageEvent & { ports?: MessagePort[] }).ports || [];
      const port = ports[0];

      if (!secret || !port) {
        logger.withTag('messageChannelController').warn('Missing secret or port on PORT_READY');
        return;
      }

      // Keep a reference by secret; callers may route by tab later if needed
      this.ports.set(secret, port);

      // Wire port lifecycle + inbound messages
      port.onmessage = this.handlePortMessage.bind(this, secret);
      port.onmessageerror = () => {
        logger.withTag('messageChannelController').error('Port message error; closing tunnel for secret:', secret);
        this.ports.delete(secret);
      };

      // ACK once so content resolves readiness
      try {
        const ready: ChannelReady = { type: 'READY' };
        port.postMessage(ready);
      } catch (e) {
        logger.withTag('messageChannelController').error('Failed to ACK on port:', e);
      }

      logger.withTag('messageChannelController').log('Port established for secret:', secret);
    }
  };

  private handlePortMessage = (secret: string, ev: MessageEvent<unknown>): void => {
    const { data } = ev;

    if (isChannelRequest(data)) {
      this.handleRequest(secret, data);
      return;
    }

    logger.withTag('messageChannelController').log('Received non-request message (secret=', secret, '):', data);
  };

  private handleRequest(secret: string, req: ChannelRequest): void {
    switch (req.action) {
      case 'PROCESS_IMAGE': {
        void this.handleProcessImage(secret, req as ChannelRequest<ProcessImageAction, IImageWithBitmap>);
        break;
      }
      default: {
        const res: ChannelResponse<string, never> = {
          id: req.id,
          type: 'response',
          action: `${req.action}-result`,
          success: false,
          error: `Unknown action: ${req.action}`,
        };
        this.send(secret, res);
      }
    }
  }

  private async handleProcessImage(
    secret: string,
    req: ChannelRequest<ProcessImageAction, IImageWithBitmap>,
  ): Promise<void> {
    const { hostname, src, bitmap, metadata, tabId: requestTabId, width, height } = req.payload;

    // Validate input
    if (!hostname) {
      logger.withTag('messageChannelController').error('Hostname is required for inference request');
      this.sendErrorResponse(secret, req.id, 'Hostname is required');
      return;
    }

    if (!src || !src.trim()) {
      logger.withTag('messageChannelController').error('Image src is required for inference request');
      this.sendErrorResponse(secret, req.id, 'Image src is required');
      return;
    }

    // Use provided tabId or fall back to active tab
    const tabId = requestTabId || (await this.getActiveTabId());
    if (!tabId) {
      logger.withTag('messageChannelController').error('Unable to determine tab ID for inference response');
      this.sendErrorResponse(secret, req.id, 'Unable to determine tab ID');
      return;
    }

    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);
      await this.orchestrationService.scheduleInferenceTask({
        input: { kind: 'bitmap', imageSrc: src, bitmap, originalWidth: width, originalHeight: height },
        hostname,
        tabId,
        hostSettings,
        imageMetadata: metadata,
      });

      // Send success response
      const res: ChannelResponse<ProcessImageAction, { processed: boolean }> = {
        id: req.id,
        type: 'response',
        action: 'PROCESS_IMAGE-result',
        success: true,
        payload: { processed: true },
      };

      this.send(secret, res);
    } catch (error) {
      logger.withTag('messageChannelController').error('Failed to process image:', error);
      this.sendErrorResponse(secret, req.id, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private sendErrorResponse(secret: string, requestId: string, errorMessage: string): void {
    const res: ChannelResponse<ProcessImageAction, never> = {
      id: requestId,
      type: 'response',
      action: 'PROCESS_IMAGE-result',
      success: false,
      error: errorMessage,
    };
    this.send(secret, res);
  }

  private async getActiveTabId(): Promise<number | undefined> {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id;
    } catch (error) {
      logger.withTag('messageChannelController').error('Failed to get active tab:', error);
      return undefined;
    }
  }

  /**
   * Send a message over the tunnel identified by `secret`.
   */
  public send(secret: string, message: unknown, transfer?: Transferable[]): boolean {
    const port = this.ports.get(secret);
    if (!port) return false;
    try {
      if (transfer && transfer.length > 0) {
        port.postMessage(message, transfer);
      } else {
        port.postMessage(message);
      }
      return true;
    } catch (e) {
      logger.withTag('messageChannelController').error('Failed to send on port (secret=', secret, '):', e);
      return false;
    }
  }
}
