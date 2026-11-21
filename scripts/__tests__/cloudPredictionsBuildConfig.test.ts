import { describe, expect, it } from 'vitest';

import { resolveCloudPredictionsBuildConfig } from '@/scripts/cloudPredictionsBuildConfig';

const env = (overrides: Record<string, string | undefined> = {}) => ({
  WXT_CLOUD_PREDICTIONS_URL: 'https://api.haramblock.com',
  WXT_CLOUD_PREDICTIONS_REPORT: 'true',
  ...overrides,
});

describe('Cloud Predictions build configuration', () => {
  it('bakes in the server URL and the report flag', () => {
    expect(resolveCloudPredictionsBuildConfig(env(), 'production')).toEqual({
      url: 'https://api.haramblock.com',
      isReportEnabled: true,
    });
  });

  it('fails a build without a server URL', () => {
    expect(() =>
      resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_URL: undefined }), 'development'),
    ).toThrow(/WXT_CLOUD_PREDICTIONS_URL/);
  });

  it.each([['http://api.haramblock.com'], [''], ['api.haramblock.com']])(
    'fails a production build whose server URL is %j',
    url => {
      expect(() => resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_URL: url }), 'production')).toThrow(
        /https/,
      );
    },
  );

  it('lets a development build talk to a local http server', () => {
    expect(
      resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_URL: 'http://localhost:5080' }), 'development')
        .url,
    ).toBe('http://localhost:5080');
  });

  it('lets a development build leave the server URL empty', () => {
    expect(resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_URL: '' }), 'development').url).toBe('');
  });

  it('fails a development build whose server URL is not an http(s) address', () => {
    expect(() =>
      resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_URL: 'ftp://cloud' }), 'development'),
    ).toThrow(/WXT_CLOUD_PREDICTIONS_URL/);
  });

  it('requires https in every mode other than development', () => {
    expect(() =>
      resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_URL: 'http://localhost:5080' }), 'no-cache'),
    ).toThrow(/https/);
  });

  it('switches reporting off when the flag says false', () => {
    expect(
      resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_REPORT: 'false' }), 'production').isReportEnabled,
    ).toBe(false);
  });

  it.each([[undefined], [''], ['yes']])('fails a build whose report flag is %j', flag => {
    expect(() => resolveCloudPredictionsBuildConfig(env({ WXT_CLOUD_PREDICTIONS_REPORT: flag }), 'production')).toThrow(
      /WXT_CLOUD_PREDICTIONS_REPORT/,
    );
  });
});
