import { When, Then } from '@wdio/cucumber-framework';

When('I open the extension options page', async () => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/options.html`);
});

Then('the options page should be visible', async () => {
  const optionsPage = await $('body').getElement();
  await expect(optionsPage).toBeExisting();
});
