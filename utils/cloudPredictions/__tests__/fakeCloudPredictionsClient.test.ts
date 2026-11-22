import { describe, expect, it } from 'vitest';

import { FakeCloudPredictionsClient } from '@/utils/cloudPredictions/testing/fakeCloudPredictionsClient';

import type {
  CloudLookupHit,
  ServedImagePrediction,
  ICloudImageReportsRequest,
  ICloudVideoReportRequest,
  IImagePrediction,
} from '@/utils/types';

const imageReports = (src: string): ICloudImageReportsRequest => ({
  reporterId: 'reporter',
  reports: [{ prediction: { src } as IImagePrediction, compatibilityKey: 'segment:person' }],
});

const videoReport = (key: string): ICloudVideoReportRequest => ({
  reporterId: 'reporter',
  report: {
    media: { key },
    hostname: 'videos.example',
    durationSec: 60,
    forcedVisibility: 'auto',
    compatibilityKey: 'segment:person',
    bucket: { modelId: 'model@1', latticeVersion: 1, formatVersion: 1, bucketStartUs: 0, samples: [] },
  },
});

const imageHit = (url: string): CloudLookupHit => ({
  kind: 'image',
  media: { url },
  compatibilityKey: 'segment:person',
  formatVersion: 1,
  prediction: { src: url } as ServedImagePrediction,
});

describe('FakeCloudPredictionsClient', () => {
  it('accepts reports and remembers what it was sent', async () => {
    const cloud = new FakeCloudPredictionsClient();
    const images = imageReports('https://cdn.example/a.jpg');
    const video = videoReport('youtube:abc');

    await expect(cloud.reportImages(images)).resolves.toEqual({ status: 'ok' });
    await expect(cloud.reportVideo(video)).resolves.toEqual({ status: 'ok' });

    expect(cloud.imageReportCalls).toEqual([images]);
    expect(cloud.videoReportCalls).toEqual([video]);
  });

  it('answers a lookup with the hits it serves and nothing for the rest', async () => {
    const cloud = new FakeCloudPredictionsClient();
    const hit = imageHit('https://cdn.example/a.jpg');
    cloud.serve(hit);

    const outcome = await cloud.lookUpPredictions({
      model: 'model@1',
      media: [{ url: 'https://cdn.example/a.jpg' }, { url: 'https://cdn.example/unknown.jpg' }, { key: 'youtube:abc' }],
    });

    expect(outcome).toEqual({ status: 'ok', hits: [hit] });
    expect(cloud.lookupCalls).toHaveLength(1);
  });

  it('does not confuse a media key with a media URL of the same text', async () => {
    const cloud = new FakeCloudPredictionsClient();
    cloud.serve({ ...imageHit('same'), media: { key: 'same' } });

    await expect(cloud.lookUpPredictions({ model: 'model@1', media: [{ url: 'same' }] })).resolves.toEqual({
      status: 'ok',
      hits: [],
    });
  });

  it('answers the next calls with scripted failures, in order, then recovers', async () => {
    const cloud = new FakeCloudPredictionsClient();
    cloud.failNext({ status: 'retryAfter', retryAfterMs: 5000 }, { status: 'rejected' });

    await expect(cloud.reportImages(imageReports('https://cdn.example/a.jpg'))).resolves.toEqual({
      status: 'retryAfter',
      retryAfterMs: 5000,
    });
    await expect(cloud.lookUpPredictions({ model: 'model@1', media: [] })).resolves.toEqual({ status: 'rejected' });
    await expect(cloud.reportVideo(videoReport('youtube:abc'))).resolves.toEqual({ status: 'ok' });
    expect(cloud.imageReportCalls).toHaveLength(1);
  });

  it('holds calls while stalled and answers them once released', async () => {
    const cloud = new FakeCloudPredictionsClient();
    cloud.stall();

    const pending = cloud.reportImages(imageReports('https://cdn.example/a.jpg'));
    const race = await Promise.race([pending, Promise.resolve('still pending')]);
    expect(race).toBe('still pending');

    cloud.release();
    await expect(pending).resolves.toEqual({ status: 'ok' });
  });

  it('fails a stalled call when its caller aborts it', async () => {
    const cloud = new FakeCloudPredictionsClient();
    cloud.stall();
    const abort = new AbortController();

    const pending = cloud.lookUpPredictions({ model: 'model@1', media: [] }, abort.signal);
    abort.abort();

    await expect(pending).resolves.toEqual({ status: 'failed' });
  });

  it('fails a call whose signal is already aborted', async () => {
    const cloud = new FakeCloudPredictionsClient();

    await expect(cloud.reportImages(imageReports('https://cdn.example/a.jpg'), AbortSignal.abort())).resolves.toEqual({
      status: 'failed',
    });
  });
});
