export type ChannelId = string;

/**
 * A typed request sent over the MessageChannel from content to background, answered by the
 * `IChannelResponse` carrying the same `id`.
 */
export interface IChannelRequest<TAction extends string = string, TPayload = unknown> {
  id: ChannelId;
  type: 'request';
  action: TAction;
  payload: TPayload;
}

/**
 * The background's answer to an `IChannelRequest`, matched to it by `id` and to its action by the
 * `-result` suffix; failures carry `error` instead of a payload.
 */
export interface IChannelResponse<TAction extends string = string, TPayload = unknown> {
  id: ChannelId;
  type: 'response';
  action: `${TAction}-result`;
  success: boolean;
  payload?: TPayload;
  error?: string;
}

export type ChannelMessage = IChannelRequest | IChannelResponse;

/**
 * The one-shot ACK the background sends once it has taken the relayed port: content may start
 * sending requests only after it arrives.
 */
export interface IChannelReady {
  type: 'READY';
}

export type ProcessImageAction = 'PROCESS_IMAGE';
