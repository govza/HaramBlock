import { Before } from '@wdio/cucumber-framework';

import { resetCloudPredictionsConsent } from '../utils/cloud-predictions.js';

Before({ tags: '@cloud' }, async () => {
  await resetCloudPredictionsConsent();
});
