/**
 * What a build bakes in about the Shared Prediction Cache: the server URL (empty only in a development build that leaves
 * Cloud Predictions off) and whether this build may send reports.
 */
interface CloudPredictionsBuildConfig {
  url: string;
  isReportEnabled: boolean;
}

type BuildEnv = Record<string, string | undefined>;

const hasProtocol = (url: string, protocols: readonly string[]): boolean =>
  URL.canParse(url) && protocols.includes(new URL(url).protocol);

const resolveUrl = (env: BuildEnv, mode: string): string => {
  const url = env.WXT_CLOUD_PREDICTIONS_URL;
  if (url === undefined) {
    throw new Error(
      'WXT_CLOUD_PREDICTIONS_URL is not set. It comes from .env.development / .env.production; override it in .env.<mode>.local.',
    );
  }
  if (mode !== 'development') {
    if (!hasProtocol(url, ['https:'])) {
      throw new Error(`WXT_CLOUD_PREDICTIONS_URL must be an https:// address in a ${mode} build, got "${url}".`);
    }
    return url;
  }
  if (url !== '' && !hasProtocol(url, ['https:', 'http:'])) {
    throw new Error(`WXT_CLOUD_PREDICTIONS_URL must be an http(s) address or empty, got "${url}".`);
  }
  return url;
};

const resolveReportFlag = (env: BuildEnv): boolean => {
  const flag = env.WXT_CLOUD_PREDICTIONS_REPORT;
  if (flag !== 'true' && flag !== 'false') {
    throw new Error(`WXT_CLOUD_PREDICTIONS_REPORT must be "true" or "false", got ${JSON.stringify(flag)}.`);
  }
  return flag === 'true';
};

export const resolveCloudPredictionsBuildConfig = (env: BuildEnv, mode: string): CloudPredictionsBuildConfig => ({
  url: resolveUrl(env, mode),
  isReportEnabled: resolveReportFlag(env),
});
