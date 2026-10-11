import { LookaheadHost } from '@/utils/lookahead/host';
import { createRangeFetchSource } from '@/utils/lookahead/rangeFetchSource';
import { createWebCodecsDecoder, toModelInputBitmap, type BitmapFrame } from '@/utils/lookahead/webCodecsDecoder';

import type { InferredSample, StoredSample } from '@/utils/lookahead/ports';
import type { ContentToHost, HookMessage, HostToContent } from '@/utils/lookahead/protocol';

const secret = new URLSearchParams(location.search).get('secret');

function serve(contentPort: MessagePort, hookPort: MessagePort): void {
  let nextRequestId = 1;
  const inferences = new Map<number, { resolve: (sample: InferredSample) => void; reject: (error: Error) => void }>();
  const cacheReads = new Map<number, (samples: StoredSample[]) => void>();
  const send = (message: HostToContent, transfer: Transferable[] = []) => contentPort.postMessage(message, transfer);

  const host = new LookaheadHost({
    decoder: open => createWebCodecsDecoder(frame => toModelInputBitmap(frame, open.inputSize)),
    inference: open => ({
      infer: ({ pointUs, frame, priority }) => {
        const { bitmap, originalWidth, originalHeight } = frame as BitmapFrame;
        const requestId = nextRequestId++;
        return new Promise((resolve, reject) => {
          inferences.set(requestId, { resolve, reject });
          send(
            {
              t: 'infer',
              requestId,
              sessionId: open.sessionId,
              pointUs,
              bitmap,
              originalWidth,
              originalHeight,
              priority,
            },
            [bitmap],
          );
        });
      },
    }),
    cache: open => ({
      read: () => {
        const requestId = nextRequestId++;
        return new Promise(resolve => {
          cacheReads.set(requestId, resolve);
          send({ t: 'cacheRead', requestId, sessionId: open.sessionId });
        });
      },
      publish: samples => send({ t: 'cachePublish', sessionId: open.sessionId, samples }),
    }),
    rangeSource: url => createRangeFetchSource(url),
    send,
    toHook: command => hookPort.postMessage(command),
  });

  hookPort.onmessage = (event: MessageEvent<HookMessage>) => host.handleHook(event.data);
  contentPort.onmessage = (event: MessageEvent<ContentToHost>) => {
    const message = event.data;
    if (message.t === 'inferResult') {
      const pending = inferences.get(message.requestId);
      inferences.delete(message.requestId);
      if (message.sample) pending?.resolve(message.sample);
      else pending?.reject(new Error('Inference failed'));
      return;
    }
    if (message.t === 'cacheSamples') {
      cacheReads.get(message.requestId)?.(message.samples);
      cacheReads.delete(message.requestId);
      return;
    }
    host.handleContent(message);
  };
}

const acceptFirstHandshake = (event: MessageEvent) => {
  if (!secret || event.data !== secret) return;
  const [contentPort, hookPort] = event.ports;
  if (!contentPort || !hookPort) return;
  globalThis.removeEventListener('message', acceptFirstHandshake);
  serve(contentPort, hookPort);
};

globalThis.addEventListener('message', acceptFirstHandshake);
