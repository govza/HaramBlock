import { lookaheadDecoder } from '@/utils/lookahead/decoderSelection';
import { LookaheadHost } from '@/utils/lookahead/host';
import { LOOKAHEAD_PORT_NAME, type FirefoxPortMessage, type OpenAnalysis } from '@/utils/lookahead/protocol';
import { createRangeFetchSource } from '@/utils/lookahead/rangeFetchSource';
import { toInferredSample } from '@/utils/lookahead/sampleScores';
import { withSourceSize, type BitmapFrame } from '@/utils/lookahead/webCodecsDecoder';
import { getLogger } from '@/utils/telemetry';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';
import type { InferencePort, InferredSample, SampleCachePort } from '@/utils/lookahead/ports';
import type { VideoIdentity } from '@/utils/videoIdentity';

const log = getLogger('lookaheadHostService');

export class LookaheadHostService {
  private nextFrameIndex = 1;

  constructor(
    private readonly inferenceService: InferenceOrchestrationService,
    private readonly hostSettingsService: HostSettingsService,
    private readonly videoPredictionCacheService: VideoPredictionCacheService,
  ) {}

  listen(): void {
    browser.runtime.onConnect.addListener(port => {
      if (port.name !== LOOKAHEAD_PORT_NAME) return;
      const host = new LookaheadHost({
        decoder: open =>
          lookaheadDecoder(open.inputSize, {
            hardwareAcceleration: 'prefer-software',
            onChosen: (codec, decoder) => log.info('lookahead.decoder.chosen', { codec, decoder }),
          }),
        inference: open => this.inferencePort(open),
        cache: open => this.cachePort(open),
        rangeSource: url => createRangeFetchSource(url),
        toHook: command => {
          try {
            port.postMessage({ t: 'toHook', command });
          } catch (error) {
            log.debug('lookahead.port.send_failed', { error });
          }
        },
        send: message => {
          try {
            port.postMessage(message);
          } catch (error) {
            log.debug('lookahead.port.send_failed', { error });
          }
        },
      });
      port.onMessage.addListener(raw => {
        const message = raw as FirefoxPortMessage;
        if (message.k === 'hook') host.handleHook(message.m);
        else host.handleContent(message.m);
      });
      port.onDisconnect.addListener(() => host.closeAll());
    });
  }

  private inferencePort(open: OpenAnalysis): InferencePort {
    return {
      infer: async ({ pointUs, frame, priority }) => {
        const { bitmap, originalWidth, originalHeight } = frame as BitmapFrame;
        const hostSettings = await this.hostSettingsService.getHostSettings(open.hostname);
        return new Promise<InferredSample>((resolve, reject) => {
          void this.inferenceService.scheduleInferenceTask({
            input: { kind: 'bitmap', imageSrc: open.sourceUrl, bitmap, originalWidth, originalHeight },
            hostname: open.hostname,
            hostSettings,
            mediaMetadata: {
              kind: 'frame',
              mediaKey: open.sourceUrl,
              sourceUrl: open.sourceUrl,
              frameIndex: this.nextFrameIndex++,
              sessionId: open.sessionId,
              timestampSec: pointUs / 1e6,
              sampleKind: 'lookahead',
            },
            priority,
            onResult: result =>
              result instanceof Error
                ? reject(result)
                : resolve(withSourceSize(toInferredSample(result), { originalWidth, originalHeight })),
          });
        });
      },
    };
  }

  private cachePort(open: OpenAnalysis): SampleCachePort {
    return {
      read: async (identity: VideoIdentity, reader) =>
        (await this.videoPredictionCacheService.getCached(identity, reader)).samples,
      publish: (identity, samples) =>
        this.videoPredictionCacheService.publish(
          identity,
          { sourceUrl: open.sourceUrl, hostname: open.hostname },
          samples,
        ),
    };
  }
}
