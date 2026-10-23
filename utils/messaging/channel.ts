import type { IChannelReady, IChannelRequest, IChannelResponse } from '@/utils/types';

export function isChannelRequest(msg: unknown): msg is IChannelRequest<string, unknown> {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return obj.type === 'request' && typeof obj.id === 'string' && typeof obj.action === 'string' && 'payload' in obj;
}

export function isChannelResponse(msg: unknown): msg is IChannelResponse<string, unknown> {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj.type === 'response' &&
    typeof obj.id === 'string' &&
    typeof obj.action === 'string' &&
    typeof obj.success === 'boolean'
  );
}

export function isChannelReady(msg: unknown): msg is IChannelReady {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === 'READY';
}
