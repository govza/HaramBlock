import type { ResolvedVideoSource } from '@/entrypoints/content/video/session/videoSource';
import type { TapRequest } from '@/utils/lookahead/protocol';

const NATIVE_HLS_PATH = /\.m3u8$/i;

export function chooseTap(source: ResolvedVideoSource): TapRequest | null {
  if (source.srcObject || !source.url) return null;
  if (source.url.startsWith('blob:')) return { kind: 'mse', objectUrl: source.url };
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (NATIVE_HLS_PATH.test(url.pathname)) return null;
  return { kind: 'progressive', url: source.url };
}
