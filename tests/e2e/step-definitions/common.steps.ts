import { Given, Then } from '@wdio/cucumber-framework';

Given('I open a webpage {string}', async (url: string) => {
  await browser.url(url);
});

Then('the page should have title {string}', async (expectedTitle: string) => {
  await expect(browser).toHaveTitle(expectedTitle);
});
