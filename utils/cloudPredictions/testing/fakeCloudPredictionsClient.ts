import type {
  CloudFailure,
  CloudLookupHit,
  CloudLookupOutcome,
  CloudMedia,
  CloudReportOutcome,
  ICloudPredictionsClient,
  ICloudImageReportsRequest,
  ICloudLookupRequest,
  ICloudVideoReportRequest,
} from '@/utils/types';

const mediaId = (media: CloudMedia): string => ('url' in media ? `url:${media.url}` : `key:${media.key}`);

/**
 * In-memory Shared Prediction Cache for service tests. It accepts every report, answers lookups from the hits given
 * to `serve`, and can be scripted to fail its next calls or to hold them until released or aborted.
 */
export class FakeCloudPredictionsClient implements ICloudPredictionsClient {
  readonly imageReportCalls: ICloudImageReportsRequest[] = [];
  readonly videoReportCalls: ICloudVideoReportRequest[] = [];
  readonly lookupCalls: ICloudLookupRequest[] = [];

  private readonly served = new Map<string, CloudLookupHit>();
  private readonly scriptedFailures: CloudFailure[] = [];
  private stalled?: { released: Promise<void>; release: () => void };

  serve(...hits: CloudLookupHit[]): void {
    for (const hit of hits) this.served.set(mediaId(hit.media), hit);
  }

  failNext(...failures: CloudFailure[]): void {
    this.scriptedFailures.push(...failures);
  }

  stall(): void {
    if (this.stalled) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.stalled = { released: promise, release: resolve };
  }

  release(): void {
    this.stalled?.release();
    this.stalled = undefined;
  }

  async reportImages(request: ICloudImageReportsRequest, signal?: AbortSignal): Promise<CloudReportOutcome> {
    this.imageReportCalls.push(request);
    return (await this.failure(signal)) ?? { status: 'ok' };
  }

  async reportVideo(request: ICloudVideoReportRequest, signal?: AbortSignal): Promise<CloudReportOutcome> {
    this.videoReportCalls.push(request);
    return (await this.failure(signal)) ?? { status: 'ok' };
  }

  async lookUpPredictions(request: ICloudLookupRequest, signal?: AbortSignal): Promise<CloudLookupOutcome> {
    this.lookupCalls.push(request);
    const failure = await this.failure(signal);
    if (failure) return failure;
    const hits = request.media.flatMap(media => this.served.get(mediaId(media)) ?? []);
    return { status: 'ok', hits };
  }

  private async failure(signal?: AbortSignal): Promise<CloudFailure | undefined> {
    if (await this.isAbortedWhileStalled(signal)) return { status: 'failed' };
    return this.scriptedFailures.shift();
  }

  private async isAbortedWhileStalled(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return true;
    if (!this.stalled) return false;
    if (!signal) {
      await this.stalled.released;
      return false;
    }
    const aborted = new Promise<boolean>(resolve => {
      signal.addEventListener('abort', () => resolve(true), { once: true });
    });
    return Promise.race([this.stalled.released.then(() => false), aborted]);
  }
}
