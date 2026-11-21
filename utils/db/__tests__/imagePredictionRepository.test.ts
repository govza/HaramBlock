import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { mediaCacheDb } from '@/utils/db/db';
import { ImagePredictionRepository } from '@/utils/db/imagePredictionRepository';

import type { IStoredImagePrediction, ReportStatus } from '@/utils/types';

const SRC = 'https://cdn.example.com/a.jpg';
const REPORTED_AT = 100;
const NOW = 500;

const row = (reportStatus?: ReportStatus): IStoredImagePrediction => ({
  src: SRC,
  hostname: 'example.com',
  width: 100,
  height: 100,
  predictions: [],
  timestamp: 5,
  cacheMetadata: { createdAt: 5, accessedAt: 5, maxAge: 2_592_000 },
  maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  processingTime: { fetchTime: 0, decodeTime: 0, queueTime: 0, inferenceTime: 0, e2eTime: 0, backend: 'wasm' },
  forcedVisibility: 'auto',
  provenance: 'own',
  ...(reportStatus ? { reportStatus, reportChangedAt: REPORTED_AT } : {}),
});

const stored = () => mediaCacheDb.imagePredictions.get(SRC);

describe('ImagePredictionRepository Report Status', () => {
  const repository = new ImagePredictionRepository();

  beforeEach(() => mediaCacheDb.imagePredictions.clear());

  it('marks a reported row pending again when its Forced Visibility flips', async () => {
    await repository.storeOwn(row('reported'));
    await expect(repository.setForcedVisibility(SRC, 'visible', NOW)).resolves.toBe(true);
    expect(await stored()).toMatchObject({
      forcedVisibility: 'visible',
      reportStatus: 'pending',
      reportChangedAt: NOW,
    });
  });

  it('retries a rejected row once its Forced Visibility flips', async () => {
    await repository.storeOwn(row('rejected'));
    await repository.setForcedVisibility(SRC, 'blocked', NOW);
    expect(await stored()).toMatchObject({ reportStatus: 'pending', reportChangedAt: NOW });
  });

  it('leaves a row without a Report Status unreported when its Forced Visibility flips', async () => {
    await repository.storeOwn(row());
    await expect(repository.setForcedVisibility(SRC, 'visible', NOW)).resolves.toBe(false);
    const flipped = await stored();
    expect(flipped?.forcedVisibility).toBe('visible');
    expect(flipped).not.toHaveProperty('reportStatus');
    expect(flipped).not.toHaveProperty('reportChangedAt');
  });

  it('does not re-report a toggle that changes nothing', async () => {
    await repository.storeOwn(row('reported'));
    await expect(repository.setForcedVisibility(SRC, 'auto', NOW)).resolves.toBe(false);
    expect(await stored()).toMatchObject({ reportStatus: 'reported', reportChangedAt: REPORTED_AT });
  });

  it('does not re-report on an access-time touch or a rehome', async () => {
    await repository.storeOwn(row('reported'));
    await repository.touch(SRC, NOW);
    await repository.rehome(SRC, 'other.example', NOW);
    expect(await stored()).toMatchObject({
      hostname: 'other.example',
      reportStatus: 'reported',
      reportChangedAt: REPORTED_AT,
    });
  });

  it('keeps the hostname a pending row is reported under when the image is seen on another host', async () => {
    await repository.storeOwn({ ...row('pending'), reportHostname: 'example.com' });
    await repository.rehome(SRC, 'wiki.corp.internal', NOW);
    await repository.setForcedVisibility(SRC, 'visible', NOW);
    expect(await stored()).toMatchObject({
      hostname: 'wiki.corp.internal',
      reportHostname: 'example.com',
      reportStatus: 'pending',
    });
  });

  it('reports nothing for a src that has no row', async () => {
    await expect(repository.setForcedVisibility(SRC, 'visible', NOW)).resolves.toBe(false);
    expect(await stored()).toBeUndefined();
  });
});
