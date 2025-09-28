import type { ChannelReady, ChannelRequest, ChannelResponse } from '@/utils/types';

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

export function isChannelReady(msg: unknown): msg is ChannelReady {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === 'READY';
}
