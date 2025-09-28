// Typed protocol definitions for MessageChannel traffic between content and background.
export type ChannelId = string;

export interface ChannelRequest<TAction extends string = string, TPayload = unknown> {
  id: ChannelId;
  type: 'request';
  action: TAction;
  payload: TPayload;
}

export interface ChannelResponse<TAction extends string = string, TPayload = unknown> {
  id: ChannelId;
  type: 'response';
  action: `${TAction}-result`;
  success: boolean;
  payload?: TPayload;
  error?: string;
}

export type ChannelMessage = ChannelRequest | ChannelResponse;

// Control: one-shot channel initialization ACK from background to content
export interface ChannelReady {
  type: 'READY';
}

// Action types
export type ProcessImageAction = 'PROCESS_IMAGE';
