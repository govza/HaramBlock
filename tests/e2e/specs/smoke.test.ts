import { browser, expect } from '@wdio/globals';

describe('Smoke Test', () => {
  it('should be able to load a website', async () => {
    await browser.url('https://example.com');
    await expect(browser).toHaveTitle('Example Domain');
  });
});
