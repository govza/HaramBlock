// Typed protocol for MessageChannel traffic between content and background.

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

export function isChannelRequest(msg: unknown): msg is ChannelRequest<string, unknown> {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return obj.type === 'request' && typeof obj.id === 'string' && typeof obj.action === 'string' && 'payload' in obj;
}

export function isChannelResponse(msg: unknown): msg is ChannelResponse<string, unknown> {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj.type === 'response' &&
    typeof obj.id === 'string' &&
    typeof obj.action === 'string' &&
    typeof obj.success === 'boolean'
  );
}

// Control: one-shot channel initialization ACK from background to content
export interface ChannelReady {
  type: 'READY';
}

export function isChannelReady(msg: unknown): msg is ChannelReady {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === 'READY';
}
