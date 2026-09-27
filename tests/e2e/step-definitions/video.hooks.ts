import { Before } from '@wdio/cucumber-framework';

import { startCapturingExtensionLogs } from '../utils/console-capture.js';
import { clearMediaCache } from '../utils/video.js';

Before({ tags: '@video' }, async () => {
  startCapturingExtensionLogs();
  await clearMediaCache();
});
