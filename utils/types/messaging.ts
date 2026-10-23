// Typed protocol definitions for MessageChannel traffic between content and background.
export type ChannelId = string;

export interface IChannelRequest<TAction extends string = string, TPayload = unknown> {
  id: ChannelId;
  type: 'request';
  action: TAction;
  payload: TPayload;
}

export interface IChannelResponse<TAction extends string = string, TPayload = unknown> {
  id: ChannelId;
  type: 'response';
  action: `${TAction}-result`;
  success: boolean;
  payload?: TPayload;
  error?: string;
}

export type ChannelMessage = IChannelRequest | IChannelResponse;

// Control: one-shot channel initialization ACK from background to content
export interface IChannelReady {
  type: 'READY';
}

// Action types
export type ProcessImageAction = 'PROCESS_IMAGE';
