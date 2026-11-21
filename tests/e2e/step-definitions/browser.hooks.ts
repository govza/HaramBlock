import { Before } from '@wdio/cucumber-framework';

Before({ tags: '@chrome-only' }, () => (browser.capabilities.browserName === 'chrome' ? undefined : 'skipped'));
