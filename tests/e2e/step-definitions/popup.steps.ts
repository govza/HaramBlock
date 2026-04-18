import { When, Then } from '@wdio/cucumber-framework';

When('I open the extension popup', async () => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);
});

Then('the popup should be visible', async () => {
  const popup = await $('body');
  await expect(popup).toBeExisting();
});

Then('the popup should display the version number', async () => {
  const versionElement = await $('p*=v');
  await expect(versionElement).toBeExisting();
});
