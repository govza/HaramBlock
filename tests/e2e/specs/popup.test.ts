describe('Popup Page', () => {
  it('should load the popup page', async () => {
    const extensionPath = await browser.getExtensionPath();
    await browser.url(`${extensionPath}/popup.html`);

    const popup = await $('body').getElement();
    await expect(popup).toBeExisting();
  });

  it('should display the version number', async () => {
    const extensionPath = await browser.getExtensionPath();
    await browser.url(`${extensionPath}/popup.html`);

    const versionElement = await $('p*=v0.');
    await expect(versionElement).toBeExisting();
  });
});
