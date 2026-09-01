import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';

import { IS_CHROME } from '@/utils/constants/environment';
import { ATTR } from '@/utils/telemetry/attributes';

import type { HbContext } from '@/utils/telemetry/config';

export const SERVICE_NAME = 'haramblock';

export function getExtensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
}

export function createResource(hbContext: HbContext, tabId?: number): Resource {
  return resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': getExtensionVersion(),
    [ATTR.context]: hbContext,
    [ATTR.version]: getExtensionVersion(),
    'browser.name': IS_CHROME ? 'chrome' : 'firefox',
    ...(tabId !== undefined ? { [ATTR.tabId]: tabId } : {}),
  });
}
